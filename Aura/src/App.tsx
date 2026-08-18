import { useState, useEffect } from 'react'

const API = 'http://localhost:8000'

const QUOTES = [
  "“The beautiful thing about learning is that nobody can take it away from you.” — B.B. King",
  "“Education is the most powerful weapon which you can use to change the world.” — Nelson Mandela",
  "“An investment in knowledge pays the best interest.” — Benjamin Franklin"
]

type ChannelState = { enabled: boolean; target: string }
type Channels = { telegram: ChannelState; whatsapp: ChannelState }

type AuraConfig = {
  aiProvider: string
  openaiKey: string
  claudeKey: string
  elearningEmail: string
  elearningPassword: string
  lmsEmail: string
  lmsPassword: string
  channels: Channels
  hasCompletedSetup: boolean
}

const DEFAULT_CONFIG: AuraConfig = {
  aiProvider: '', openaiKey: '', claudeKey: '',
  elearningEmail: '', elearningPassword: '', lmsEmail: '', lmsPassword: '',
  channels: {
    telegram: { enabled: false, target: '' },
    whatsapp: { enabled: false, target: '' },
  },
  hasCompletedSetup: false,
}

type StatusChannel = { enabled: boolean; target: string; configured: boolean; paired: boolean }
type AuraStatus = {
  openclaw: boolean
  ollama: boolean
  aiProvider: string
  channels: { telegram: StatusChannel; whatsapp: StatusChannel }
} | null

export default function App() {
  // Steps:
  // 0: Welcome
  // 1: OpenClaw Check
  // 2: AI Selection
  // 3: Ollama Install (Conditional)
  // 4: Comm Channels
  // 5: Settings
  // 6: Main App
  const [setupStep, setSetupStep] = useState(0)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [hasCompletedSetup, setHasCompletedSetup] = useState(false)
  const [activeTab, setActiveTab] = useState('record')
  const [quoteIndex, setQuoteIndex] = useState(0)

  const [config, setConfig] = useState<AuraConfig>(DEFAULT_CONFIG)
  const [status, setStatus] = useState<AuraStatus>(null)
  const [channelBusy, setChannelBusy] = useState<string>('') // which channel is being (re)detected

  // Dependency state
  const [depStatus, setDepStatus] = useState('Checking OpenClaw natively...')
  const [ollamaStatus, setOllamaStatus] = useState('') // 'checking', 'missing', 'installing', 'ready'

  const [isRecording, setIsRecording] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [summary, setSummary] = useState('')
  const [summarySent, setSummarySent] = useState('') // last summary text the agent actually saw
  const [attachments, setAttachments] = useState<File[]>([])
  const [agentPrompt, setAgentPrompt] = useState('')
  const [chatLog, setChatLog] = useState<{ role: 'user' | 'agent' | 'system'; text: string }[]>([])
  const [agentBusy, setAgentBusy] = useState(false)
  const [talkingToChannel, setTalkingToChannel] = useState<string>('')
  const [lectures, setLectures] = useState<any[]>([])
  const [showLectureList, setShowLectureList] = useState(false)

  // Ask Library (RAG over past lectures)
  const [libraryChat, setLibraryChat] = useState<{ role: 'user' | 'agent'; text: string }[]>([])
  const [libraryQuestion, setLibraryQuestion] = useState('')
  const [libraryBusy, setLibraryBusy] = useState(false)

  // Marks Upload
  const [marksInstructions, setMarksInstructions] = useState('')
  const [marksText, setMarksText] = useState('')
  const [marksFile, setMarksFile] = useState<File | null>(null)
  const [marksChat, setMarksChat] = useState<{ role: 'user' | 'agent'; text: string }[]>([])
  const [marksBusy, setMarksBusy] = useState(false)

  // ── Config / status persistence ─────────────────────────────────
  const postConfig = async (partial: Partial<AuraConfig>) => {
    try {
      const res = await fetch(`${API}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      })
      const data = await res.json()
      setConfig(prev => ({ ...prev, ...data }))
      return data
    } catch (err) {
      console.error('Failed to save config', err)
      return null
    }
  }

  const refreshStatus = async () => {
    try {
      const res = await fetch(`${API}/status`)
      const data = await res.json()
      setStatus(data)
      return data
    } catch (err) {
      console.error('Failed to fetch status', err)
      return null
    }
  }

  // Load persisted config on first mount — skip the wizard entirely if setup
  // was already completed in a previous launch. The backend takes several
  // seconds to cold-start (spawned fresh by Electron on every launch), so
  // this retries instead of giving up on the first connection-refused and
  // silently falling back to "run the wizard again".
  useEffect(() => {
    let cancelled = false
    const loadConfig = async () => {
      const maxAttempts = 30
      for (let attempt = 1; attempt <= maxAttempts && !cancelled; attempt++) {
        try {
          const res = await fetch(`${API}/config`)
          const data: AuraConfig = await res.json()
          if (cancelled) return
          setConfig(data)
          if (data.hasCompletedSetup) {
            setHasCompletedSetup(true)
            setSetupStep(6)
          }
          setConfigLoaded(true)
          refreshStatus()
          return
        } catch (err) {
          await new Promise(r => setTimeout(r, 1000))
        }
      }
      if (!cancelled) setConfigLoaded(true) // give up gracefully, run the wizard fresh
    }
    loadConfig()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (activeTab === 'library') {
      fetch(`${API}/lectures`)
        .then(res => res.json())
        .then(data => {
          if (data.status === 'ok') setLectures(data.lectures)
        })
        .catch(console.error)
    }
  }, [activeTab])

  useEffect(() => {
    if (setupStep === 5 || setupStep === 6) refreshStatus()
  }, [setupStep])

  useEffect(() => {
    const interval = setInterval(() => {
      setQuoteIndex(i => (i + 1) % QUOTES.length)
    }, 8000)
    return () => clearInterval(interval)
  }, [])

  // Default "talking to" channel = first enabled+configured one
  useEffect(() => {
    if (talkingToChannel && status?.channels[talkingToChannel as 'telegram' | 'whatsapp']?.configured) return
    const firstConfigured = (['telegram', 'whatsapp'] as const).find(c => status?.channels[c]?.configured)
    if (firstConfigured) setTalkingToChannel(firstConfigured)
  }, [status])

  const nextStep = () => setSetupStep(s => s + 1)

  // Screen 1 Logic: Run OpenClaw check with retries
  useEffect(() => {
    if (setupStep !== 1) return
    let cancelled = false
    let attempt = 0
    const maxAttempts = 30

    const tryConnect = async () => {
      while (!cancelled && attempt < maxAttempts) {
        attempt++
        setDepStatus(`Connecting to backend... (${attempt}/${maxAttempts})`)
        try {
          const res = await fetch(`${API}/health/dependencies?check=openclaw`)
          const data = await res.json()
          if (cancelled) return
          if (data.status === 'ok') {
            setDepStatus('OpenClaw ready!')
            setTimeout(() => { if (!cancelled) setSetupStep(2) }, 500)
            return
          } else {
            setDepStatus('OpenClaw not found, proceeding...')
            setTimeout(() => { if (!cancelled) setSetupStep(2) }, 1500)
            return
          }
        } catch {
          // Backend not ready yet, wait and retry
          await new Promise(r => setTimeout(r, 1000))
        }
      }
      if (!cancelled) {
        setDepStatus('Backend did not start. Please restart the app.')
      }
    }

    tryConnect()
    return () => { cancelled = true }
  }, [setupStep])

  const handleAISelection = async (provider: string) => {
    setConfig({ ...config, aiProvider: provider })
    if (provider === 'Ollama') {
      setSetupStep(3) // Go to Ollama checking screen
      setOllamaStatus('checking')
      try {
        const res = await fetch(`${API}/health/dependencies?check=ollama`)
        const data = await res.json()
        if (data.status === 'ok') {
          setOllamaStatus('ready')
          setTimeout(() => setSetupStep(4), 1000) // auto advance
        } else {
          setOllamaStatus('missing')
        }
      } catch (e) {
        setOllamaStatus('missing')
      }
    } else {
      setSetupStep(4) // Skip to comm channel
    }
  }

  const installOllama = async () => {
    setOllamaStatus('installing')
    await fetch(`${API}/install/ollama`, { method: 'POST' })
    // Poll until ready
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`${API}/health/dependencies?check=ollama`)
        const data = await res.json()
        if (data.status === 'ok') {
          clearInterval(poll)
          setOllamaStatus('ready')
          setTimeout(() => setSetupStep(4), 1000)
        }
      } catch (e) {}
    }, 3000)
  }

  const handleRecordToggle = async () => {
    if (!isRecording) {
      setIsRecording(true)
      await fetch(`${API}/record/start`, { method: 'POST' })
    } else {
      setIsRecording(false)
      setIsProcessing(true)
      try {
        const res = await fetch(`${API}/record/stop`, { method: 'POST' })
        const data = await res.json()
        const newSummary = data.summary || 'Error: No summary returned.'
        setSummary(newSummary)
        setSummarySent(newSummary)
        setChatLog(
          newSummary.includes('UPLOAD NEEDED: YES')
            ? [{ role: 'system', text: 'The summary flags something that may need uploading to eLearning.' }]
            : []
        )
        setActiveTab('review')
      } catch (err) {
        setSummary(`Error connecting to backend: ${err instanceof Error ? err.message : String(err)}`)
        setChatLog([])
        setActiveTab('review')
      } finally {
        setIsProcessing(false)
      }
    }
  }

  // ── Channel toggling (Telegram / WhatsApp, independent, both can be on) ──
  const toggleChannel = async (channel: 'telegram' | 'whatsapp', enabled: boolean) => {
    setChannelBusy(channel)
    try {
      const formData = new FormData()
      formData.append('enabled', String(enabled))
      const res = await fetch(`${API}/channels/${channel}/configure`, { method: 'POST', body: formData })
      const data = await res.json()
      setConfig(prev => ({
        ...prev,
        channels: { ...prev.channels, [channel]: { enabled: data.enabled, target: data.target } },
      }))
      await refreshStatus()
    } catch (err) {
      console.error(`Failed to configure ${channel}`, err)
    } finally {
      setChannelBusy('')
    }
  }

  const launchConfigurator = () => {
    fetch(`${API}/openclaw/setup`, { method: 'POST' })
  }

  const handleCommNext = async () => {
    await postConfig({ channels: config.channels })
    setSetupStep(5)
  }

  const finishSetup = async () => {
    await postConfig({ ...config, hasCompletedSetup: true })
    setHasCompletedSetup(true)
    setSetupStep(6)
  }

  // Single entry point for every agent interaction on the Review screen —
  // the upload-detected quick action, a typed prompt, and file attachments
  // all funnel through here so they show up as one continuous conversation
  // instead of separate disconnected controls.
  const sendToAgent = async (text: string, filesToSend: File[] = []) => {
    if (!text.trim() || agentBusy) return
    setAgentBusy(true)
    const displayText = filesToSend.length
      ? `${text} (attached: ${filesToSend.map(f => f.name).join(', ')})`
      : text
    setChatLog(prev => [...prev, { role: 'user', text: displayText }])

    const formData = new FormData()
    formData.append('prompt', text)
    formData.append('summary', summary)
    formData.append('channel', talkingToChannel)
    filesToSend.forEach(f => formData.append('files', f))

    try {
      const res = await fetch(`${API}/agent/execute`, { method: 'POST', body: formData })
      const data = await res.json()
      setSummarySent(summary)
      setChatLog(prev => [...prev, { role: 'agent', text: data.message || (data.status === 'success' ? 'Done.' : 'Agent responded.') }])
    } catch (err) {
      setChatLog(prev => [...prev, { role: 'agent', text: `Error reaching the agent: ${err instanceof Error ? err.message : String(err)}` }])
    } finally {
      setAgentBusy(false)
    }
  }

  const handleUploadQuickAction = () => sendToAgent(
    'Read the UPLOAD REASON in the summary. Tell me clearly what needs to be uploaded and where — if you cannot automate the actual eLearning submission yet, say so plainly instead of claiming you did it, and offer to help me prepare it manually.'
  )

  const handleAgentPrompt = () => {
    if (!agentPrompt) return
    sendToAgent(agentPrompt, attachments)
    setAgentPrompt('')
    setAttachments([])
  }

  const handleSendCorrection = () => sendToAgent(
    `I corrected the summary. Please use this updated version from now on:\n\n${summary}`
  )

  // ── Ask Library: RAG-style Q&A over every past lecture ──────────
  const handleLibraryAsk = async () => {
    if (!libraryQuestion.trim() || libraryBusy) return
    const question = libraryQuestion
    setLibraryQuestion('')
    setLibraryBusy(true)
    setLibraryChat(prev => [...prev, { role: 'user', text: question }])

    const formData = new FormData()
    formData.append('question', question)
    try {
      const res = await fetch(`${API}/library/ask`, { method: 'POST', body: formData })
      const data = await res.json()
      setLibraryChat(prev => [...prev, { role: 'agent', text: data.answer || data.message || 'No answer returned.' }])
    } catch (err) {
      setLibraryChat(prev => [...prev, { role: 'agent', text: `Error: ${err instanceof Error ? err.message : String(err)}` }])
    } finally {
      setLibraryBusy(false)
    }
  }

  // ── Marks Upload: hand a file or typed marks + instructions to the agent.
  // Reuses the exact same /agent/execute plumbing as the Review chat — LMS
  // submission itself isn't automated yet, so the prompt says so explicitly.
  const handleMarksSend = async () => {
    if ((!marksText.trim() && !marksFile) || marksBusy || !talkingToChannel) return
    setMarksBusy(true)
    const displaySummary = [
      marksInstructions && `Instructions: ${marksInstructions}`,
      marksFile && `File: ${marksFile.name}`,
      marksText && 'Typed marks included',
    ].filter(Boolean).join(' · ')
    setMarksChat(prev => [...prev, { role: 'user', text: displaySummary || 'Sent marks' }])

    const promptParts = ['The teacher wants to upload marks to the LMS.']
    if (marksInstructions) promptParts.push(`Instructions: ${marksInstructions}`)
    if (marksText) promptParts.push(`Marks (typed directly):\n${marksText}`)
    promptParts.push(
      'LMS upload automation is not built yet — read the data, tell the teacher what you found and what you would enter, ' +
      'and say plainly that you cannot submit it to the LMS automatically instead of claiming you did.'
    )

    const formData = new FormData()
    formData.append('prompt', promptParts.join('\n\n'))
    formData.append('summary', '')
    formData.append('channel', talkingToChannel)
    if (marksFile) formData.append('files', marksFile)

    try {
      const res = await fetch(`${API}/agent/execute`, { method: 'POST', body: formData })
      const data = await res.json()
      setMarksChat(prev => [...prev, { role: 'agent', text: data.message || 'Agent responded.' }])
      setMarksInstructions('')
      setMarksText('')
      setMarksFile(null)
    } catch (err) {
      setMarksChat(prev => [...prev, { role: 'agent', text: `Error reaching the agent: ${err instanceof Error ? err.message : String(err)}` }])
    } finally {
      setMarksBusy(false)
    }
  }

  const renderWelcome = () => (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px', position: 'relative' }}>
      <div className="animate-fade-in" style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: '3rem', marginBottom: '8px' }}>Aura</h1>
        <h3 style={{ fontWeight: 400, color: 'var(--text-secondary)', marginBottom: '32px' }}>Academic Recording Assistant</h3>
        <button className="btn-primary" onClick={nextStep} style={{ padding: '12px 32px', fontSize: '1.1rem' }}>Begin Setup</button>
      </div>

      {/* Rotating Quotes in Background */}
      <div style={{ position: 'absolute', bottom: '30px', left: 0, right: 0, textAlign: 'center', fontStyle: 'italic', fontSize: '0.9rem', color: 'var(--text-secondary)', pointerEvents: 'none' }}>
        <p key={quoteIndex} className="animate-fade-in">{QUOTES[quoteIndex]}</p>
      </div>
    </div>
  )

  const renderOpenClawCheck = () => (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
      <div className="animate-fade-in" style={{ textAlign: 'center', padding: '40px 0', color: 'var(--accent-secondary)' }}>
        <div style={{ marginBottom: '16px', fontSize: '1.2rem' }}>Loading...</div>
        <div>{depStatus}</div>
      </div>

      {/* Rotating Quotes */}
      <div style={{ position: 'absolute', bottom: '30px', left: 0, right: 0, textAlign: 'center', fontStyle: 'italic', fontSize: '0.9rem', color: 'var(--text-secondary)', pointerEvents: 'none' }}>
        <p key={quoteIndex} className="animate-fade-in">{QUOTES[quoteIndex]}</p>
      </div>
    </div>
  )

  const renderAIOptions = () => (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px' }}>
      <div className="animate-fade-in" style={{ maxWidth: '800px', width: '100%' }}>
        <h2>AI Engine</h2>
        <p style={{ marginBottom: '24px' }}>Select the processing engine for transcription and summarization.</p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '24px' }}>
          <div className={`option-card ${config.aiProvider === 'Ollama' ? 'selected' : ''}`} onClick={() => handleAISelection('Ollama')}>
            <h3 style={{ fontSize: '1.1rem' }}>Ollama (Local)</h3>
            <p style={{ fontSize: '0.85rem' }}>Maximum privacy. Runs directly on your machine without internet.</p>
          </div>
          <div className={`option-card ${config.aiProvider === 'Claude' ? 'selected' : ''}`} onClick={() => setConfig({ ...config, aiProvider: 'Claude' })}>
            <h3 style={{ fontSize: '1.1rem' }}>Claude</h3>
            <p style={{ fontSize: '0.85rem' }}>High accuracy reasoning. Ideal for complex academic summaries.</p>
          </div>
          <div className={`option-card ${config.aiProvider === 'OpenAI' ? 'selected' : ''}`} onClick={() => setConfig({ ...config, aiProvider: 'OpenAI' })}>
            <h3 style={{ fontSize: '1.1rem' }}>OpenAI</h3>
            <p style={{ fontSize: '0.85rem' }}>Balanced performance and speed via GPT models.</p>
          </div>
        </div>

        {config.aiProvider === 'OpenAI' && (
          <div style={{ marginBottom: '24px', animation: 'fadeIn 0.2s' }}>
            <h3 style={{ fontSize: '1rem', marginBottom: '8px' }}>OpenAI Configuration</h3>
            <input type="password" className="input-field" placeholder="sk-..." value={config.openaiKey} onChange={e => setConfig({ ...config, openaiKey: e.target.value })} />
          </div>
        )}

        {config.aiProvider === 'Claude' && (
          <div style={{ marginBottom: '24px', animation: 'fadeIn 0.2s' }}>
            <h3 style={{ fontSize: '1rem', marginBottom: '8px' }}>Anthropic Configuration</h3>
            <input type="password" className="input-field" placeholder="sk-ant-..." value={config.claudeKey} onChange={e => setConfig({ ...config, claudeKey: e.target.value })} />
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'auto' }}>
          <button className="btn-secondary" onClick={() => setSetupStep(1)}>Back</button>
          <button
            className="btn-primary"
            onClick={async () => { await postConfig({ aiProvider: config.aiProvider, openaiKey: config.openaiKey, claudeKey: config.claudeKey }); handleAISelection(config.aiProvider) }}
            disabled={!config.aiProvider || (config.aiProvider === 'OpenAI' && !config.openaiKey) || (config.aiProvider === 'Claude' && !config.claudeKey)}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )

  const renderOllamaCheck = () => (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px' }}>
      <div className="animate-fade-in" style={{ textAlign: 'center', maxWidth: '600px', width: '100%' }}>
        <h2>Ollama Engine</h2>
        <div style={{ margin: '32px 0' }}>
          {ollamaStatus === 'checking' && <p>Checking for local Ollama installation...</p>}
          {ollamaStatus === 'ready' && <p style={{ color: 'var(--accent-secondary)' }}>Ollama is ready! Proceeding...</p>}
          {ollamaStatus === 'installing' && (
            <div>
              <p>Installing Ollama in the background...</p>
              <div style={{ width: '100%', height: '4px', background: 'var(--bg-hover)', marginTop: '16px', overflow: 'hidden' }}>
                <div style={{ width: '50%', height: '100%', background: 'var(--accent-primary)', animation: 'progress 2s infinite linear' }} />
              </div>
            </div>
          )}
          {ollamaStatus === 'missing' && (
            <div>
              <p style={{ color: 'var(--danger)', marginBottom: '16px' }}>Ollama is not installed on this machine.</p>
              <button className="btn-primary" onClick={installOllama}>Download & Install Ollama</button>
            </div>
          )}
        </div>

        {ollamaStatus === 'missing' && (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button className="btn-secondary" onClick={() => setSetupStep(2)}>Back to Engines</button>
          </div>
        )}
      </div>
    </div>
  )

  const channelLabel: Record<string, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp' }

  const renderChannelCard = (channel: 'telegram' | 'whatsapp') => {
    const cfg = config.channels[channel]
    const live = status?.channels[channel]
    const busy = channelBusy === channel
    return (
      <div
        key={channel}
        className={`option-card ${cfg.enabled ? 'selected' : ''}`}
        onClick={() => !busy && toggleChannel(channel, !cfg.enabled)}
      >
        <h3 style={{ fontSize: '1.1rem' }}>{channelLabel[channel]}</h3>
        <p style={{ fontSize: '0.85rem' }}>
          {channel === 'telegram' ? 'Fast mobile delivery via OpenClaw.' : 'Direct integration via OpenClaw.'}
        </p>
        {busy && <p style={{ fontSize: '0.8rem', color: 'var(--accent-secondary)' }}>Detecting…</p>}
        {!busy && cfg.enabled && (
          live?.paired
            ? <p style={{ fontSize: '0.8rem', color: 'var(--accent-secondary)' }}>Linked — chat {cfg.target || 'detecting…'}</p>
            : <p style={{ fontSize: '0.8rem', color: 'var(--danger)' }}>Not paired in OpenClaw yet — use "Link Account" below</p>
        )}
      </div>
    )
  }

  const renderCommOptions = () => (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px' }}>
      <div className="animate-fade-in" style={{ maxWidth: '800px', width: '100%' }}>
        <h2>Delivery Channels</h2>
        <p style={{ marginBottom: '24px' }}>Pick any combination of channels to receive and talk back to your lecture summaries on. You can enable both — replying in either chat continues that same conversation with the agent.</p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px', marginBottom: '24px' }}>
          {renderChannelCard('telegram')}
          {renderChannelCard('whatsapp')}
        </div>

        {(config.channels.telegram.enabled || config.channels.whatsapp.enabled) && (
          <div style={{ marginBottom: '24px', animation: 'fadeIn 0.2s', background: 'rgba(255,255,255,0.05)', padding: '16px', borderRadius: '8px' }}>
            <h3 style={{ fontSize: '1rem', marginBottom: '8px' }}>OpenClaw Configuration</h3>
            <p style={{ fontSize: '0.85rem', marginBottom: '16px', color: 'var(--text-secondary)' }}>
              If a channel above shows "Not paired yet", launch the interactive terminal below to pair it (QR code for WhatsApp, bot link for Telegram), then click the channel card again to re-detect.
            </p>
            <button className="btn-secondary" onClick={launchConfigurator}>
              Launch OpenClaw Configurator ↗
            </button>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'auto' }}>
          <button className="btn-secondary" onClick={() => setSetupStep(2)}>Back</button>
          <button className="btn-primary" onClick={handleCommNext}>Next</button>
        </div>
      </div>
    </div>
  )

  const renderSettings = () => (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px', overflowY: 'auto' }}>
      <div className="animate-fade-in" style={{ maxWidth: '800px', width: '100%', margin: 'auto' }}>
        <h2>Aura Settings</h2>
        <p style={{ marginBottom: '24px' }}>Configure all your application settings here.</p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '24px' }}>
          {/* AI Settings */}
          <div style={{ background: 'rgba(255,255,255,0.02)', padding: '24px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
            <h3 style={{ fontSize: '1.1rem', marginBottom: '16px' }}>AI Engine {status && <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>(active: {status.aiProvider})</span>}</h3>
            <select className="input-field" style={{ marginBottom: '12px' }} value={config.aiProvider} onChange={e => setConfig({ ...config, aiProvider: e.target.value })}>
              <option value="Ollama">Ollama (Local)</option>
              <option value="OpenAI">OpenAI</option>
              <option value="Claude">Claude</option>
            </select>
            {config.aiProvider === 'OpenAI' && <input type="password" className="input-field" placeholder="OpenAI API Key" value={config.openaiKey} onChange={e => setConfig({ ...config, openaiKey: e.target.value })} />}
            {config.aiProvider === 'Claude' && <input type="password" className="input-field" placeholder="Claude API Key" value={config.claudeKey} onChange={e => setConfig({ ...config, claudeKey: e.target.value })} />}
          </div>

          {/* Comm Settings */}
          <div style={{ background: 'rgba(255,255,255,0.02)', padding: '24px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
            <h3 style={{ fontSize: '1.1rem', marginBottom: '16px' }}>Delivery Channels</h3>
            {(['telegram', 'whatsapp'] as const).map(channel => {
              const cfg = config.channels[channel]
              const live = status?.channels[channel]
              return (
                <div key={channel} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <div>
                    <div style={{ fontSize: '0.9rem' }}>{channelLabel[channel]}</div>
                    <div style={{ fontSize: '0.75rem', color: cfg.enabled ? (live?.paired ? 'var(--accent-secondary)' : 'var(--danger)') : 'var(--text-secondary)' }}>
                      {!cfg.enabled ? 'Off' : live?.paired ? `Linked · ${cfg.target}` : 'Enabled, not paired yet'}
                    </div>
                  </div>
                  <button className="btn-secondary" onClick={() => toggleChannel(channel, !cfg.enabled)} disabled={channelBusy === channel}>
                    {cfg.enabled ? 'Disable' : 'Enable'}
                  </button>
                </div>
              )
            })}
            <button className="btn-secondary" style={{ width: '100%', marginTop: '8px' }} onClick={launchConfigurator}>Launch Configurator</button>
          </div>

          <div style={{ background: 'rgba(255,255,255,0.02)', padding: '24px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
            <h3 style={{ fontSize: '1.1rem', marginBottom: '16px' }}>E-Learning Portal</h3>
            <input type="text" className="input-field" placeholder="Email / User ID" value={config.elearningEmail} onChange={e => setConfig({ ...config, elearningEmail: e.target.value })} style={{ marginBottom: '12px' }} />
            <input type="password" className="input-field" placeholder="Password" value={config.elearningPassword} onChange={e => setConfig({ ...config, elearningPassword: e.target.value })} />
            <p style={{ fontSize: '0.75rem', marginTop: '8px' }}>Automated eLearning uploads aren't wired up yet — these are stored for when that lands.</p>
          </div>

          <div style={{ background: 'rgba(255,255,255,0.02)', padding: '24px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
            <h3 style={{ fontSize: '1.1rem', marginBottom: '16px' }}>LMS Portal</h3>
            <input type="text" className="input-field" placeholder="Email / User ID" value={config.lmsEmail} onChange={e => setConfig({ ...config, lmsEmail: e.target.value })} style={{ marginBottom: '12px' }} />
            <input type="password" className="input-field" placeholder="Password" value={config.lmsPassword} onChange={e => setConfig({ ...config, lmsPassword: e.target.value })} />
            <p style={{ fontSize: '0.75rem', marginTop: '8px' }}>Automated marks upload isn't wired up yet — these are stored for when that lands.</p>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'auto' }}>
          {hasCompletedSetup ? (
            <button className="btn-primary" onClick={finishSetup}>Save & Close</button>
          ) : (
            <>
              <button className="btn-secondary" onClick={() => setSetupStep(4)}>Back</button>
              <div style={{ display: 'flex', gap: '16px' }}>
                <button className="btn-secondary" onClick={finishSetup}>Skip</button>
                <button className="btn-primary" onClick={finishSetup}>Finish Setup</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )

  const configuredChannels = (['telegram', 'whatsapp'] as const).filter(c => status?.channels[c]?.configured)

  const renderMainApp = () => (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      <div className="sidebar" style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 16px', marginBottom: '28px' }}>
          <h2 style={{ fontSize: '1.15rem', color: 'var(--text-primary)', fontWeight: 600, letterSpacing: '0.06em' }}>AURA</h2>
          <button style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '1.1rem' }} onClick={() => setSetupStep(5)} title="Settings">⚙️</button>
        </div>
        <button className={`tab-btn ${activeTab === 'record' ? 'active' : ''}`} onClick={() => setActiveTab('record')}>🎙️&nbsp;&nbsp;Record Session</button>
        {summary && <button className={`tab-btn ${activeTab === 'review' ? 'active' : ''}`} onClick={() => setActiveTab('review')}>📝&nbsp;&nbsp;Review & Dispatch</button>}
        <button className={`tab-btn ${activeTab === 'marks' ? 'active' : ''}`} onClick={() => setActiveTab('marks')}>📊&nbsp;&nbsp;Marks Upload</button>
        <button className={`tab-btn ${activeTab === 'library' ? 'active' : ''}`} onClick={() => setActiveTab('library')}>🔎&nbsp;&nbsp;Ask Library</button>

        <div style={{ marginTop: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {configuredChannels.length === 0 && <span className="status-pill warn">No channel linked</span>}
          {configuredChannels.map(c => <span key={c} className="status-pill ok">● {channelLabel[c]} linked</span>)}
        </div>
      </div>

      <div className="content-area">
        {activeTab === 'record' && (
          <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
            <h2 style={{ marginBottom: '8px' }}>{isRecording ? 'Recording in progress...' : 'Ready to Record'}</h2>
            <p style={{ marginBottom: '48px', textAlign: 'center', maxWidth: '400px' }}>
              {isProcessing ? 'Transcribing via Whisper and generating summary...' : 'Click to start transcribing.'}
            </p>
            {!isProcessing && (
              <button
                className={`record-btn ${isRecording ? 'recording' : ''}`}
                aria-label="Toggle Recording"
                onClick={handleRecordToggle}
              ></button>
            )}
          </div>
        )}

        {activeTab === 'review' && (
          <div className="animate-fade-in" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '12px' }}>
              <h2 style={{ marginBottom: 0 }}>Review & Actions</h2>
              <span style={{ fontSize: '0.8rem', color: configuredChannels.length > 0 ? 'var(--accent-secondary)' : 'var(--danger)' }}>
                {configuredChannels.length > 0
                  ? `✓ Delivered to ${configuredChannels.map(c => channelLabel[c]).join(' & ')}`
                  : 'Not sent — no channel linked'}
              </span>
            </div>

            {/* Summary: editable, with an explicit action once it's actually been changed */}
            <div style={{ marginBottom: '16px' }}>
              <textarea
                className="input-field"
                style={{ width: '100%', height: '160px', resize: 'vertical' }}
                value={summary}
                onChange={e => setSummary(e.target.value)}
              />
              {summary !== summarySent && (
                <button className="btn-secondary" style={{ marginTop: '8px' }} onClick={handleSendCorrection} disabled={agentBusy || !talkingToChannel}>
                  Send correction to agent
                </button>
              )}
            </div>

            {/* Conversation with the agent — everything (upload prompt, your questions, replies) lands here */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden' }}>
              <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {chatLog.length === 0 && (
                  <p style={{ textAlign: 'center', marginTop: '20px' }}>Ask the agent to add something, find a file, or explain what needs uploading.</p>
                )}
                {chatLog.map((m, i) => (
                  <div key={i} style={{
                    alignSelf: m.role === 'user' ? 'flex-end' : 'stretch',
                    maxWidth: m.role === 'user' ? '80%' : '100%',
                    background: m.role === 'user' ? 'var(--accent-primary)' : m.role === 'system' ? 'var(--danger-bg)' : 'var(--bg-panel-hover)',
                    border: m.role === 'system' ? '1px solid var(--danger)' : 'none',
                    color: m.role === 'user' ? 'white' : 'var(--text-primary)',
                    padding: '10px 14px', borderRadius: '10px', fontSize: '0.9rem', whiteSpace: 'pre-wrap',
                  }}>
                    {m.text}
                    {m.role === 'system' && (
                      <div style={{ marginTop: '10px' }}>
                        <button className="btn-primary" style={{ background: 'var(--danger)', border: 'none', padding: '6px 14px', fontSize: '0.85rem' }} onClick={handleUploadQuickAction} disabled={agentBusy || !talkingToChannel}>
                          Ask agent about this
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                {agentBusy && <p style={{ fontSize: '0.85rem' }}>Agent is working…</p>}
              </div>

              <div style={{ borderTop: '1px solid var(--border-color)', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {configuredChannels.length > 0 ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      Talking to <strong>{channelLabel[talkingToChannel] || '...'}</strong> — replies there continue this same conversation.
                    </span>
                    {configuredChannels.length > 1 && (
                      <div style={{ display: 'flex', gap: '4px' }}>
                        {configuredChannels.map(c => (
                          <button
                            key={c}
                            className="btn-secondary"
                            style={{ padding: '2px 8px', fontSize: '0.75rem', ...(talkingToChannel === c ? { borderColor: 'var(--accent-primary)', color: 'var(--text-primary)' } : {}) }}
                            onClick={() => setTalkingToChannel(c)}
                          >
                            {channelLabel[c]}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <span style={{ fontSize: '0.75rem', color: 'var(--danger)' }}>Link a channel in Settings to talk to the agent.</span>
                )}
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <label className="btn-secondary" style={{ padding: '10px 12px', cursor: 'pointer', margin: 0 }} title="Attach a file for the agent">
                    📎
                    <input
                      type="file"
                      multiple
                      style={{ display: 'none' }}
                      onChange={e => e.target.files && setAttachments(Array.from(e.target.files))}
                    />
                  </label>
                  <input
                    type="text"
                    className="input-field"
                    style={{ flex: 1, margin: 0 }}
                    placeholder={attachments.length ? `${attachments.length} file(s) attached — say what to do with them...` : "Tell the agent what to do..."}
                    value={agentPrompt}
                    onChange={e => setAgentPrompt(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAgentPrompt()}
                    disabled={!talkingToChannel}
                  />
                  <button className="btn-primary" onClick={handleAgentPrompt} disabled={!agentPrompt || agentBusy || !talkingToChannel}>
                    Send
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'library' && (
          <div className="animate-fade-in" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '12px' }}>
              <h2 style={{ marginBottom: 0 }}>Ask Library</h2>
              <button className="btn-text" style={{ fontSize: '0.8rem' }} onClick={() => setShowLectureList(s => !s)}>
                {showLectureList ? 'Hide' : 'Browse'} past lectures ({lectures.length})
              </button>
            </div>

            {showLectureList && (
              <div style={{ maxHeight: '220px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '12px', marginBottom: '16px', background: 'var(--bg-panel)' }}>
                {lectures.length === 0 ? (
                  <p style={{ textAlign: 'center' }}>No past lectures found yet.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {lectures.map((l, idx) => (
                      <div key={idx} style={{ background: 'rgba(255,255,255,0.02)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '6px' }}>
                          {new Date(l.timestamp).toLocaleString()}
                        </div>
                        <div style={{ fontSize: '0.85rem', whiteSpace: 'pre-wrap' }}>{l.summary}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, border: '1px solid var(--border-color)', borderRadius: '8px', overflow: 'hidden' }}>
              <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {libraryChat.length === 0 && (
                  <p style={{ textAlign: 'center', marginTop: '20px' }}>Ask anything about past lectures — e.g. "when did I mention the midterm?" or "what did I teach on OOP?"</p>
                )}
                {libraryChat.map((m, i) => (
                  <div key={i} style={{
                    alignSelf: m.role === 'user' ? 'flex-end' : 'stretch',
                    maxWidth: m.role === 'user' ? '80%' : '100%',
                    background: m.role === 'user' ? 'var(--accent-primary)' : 'var(--bg-panel-hover)',
                    color: m.role === 'user' ? 'white' : 'var(--text-primary)',
                    padding: '10px 14px', borderRadius: '10px', fontSize: '0.9rem', whiteSpace: 'pre-wrap',
                  }}>
                    {m.text}
                  </div>
                ))}
                {libraryBusy && <p style={{ fontSize: '0.85rem' }}>Searching past lectures…</p>}
              </div>
              <div style={{ borderTop: '1px solid var(--border-color)', padding: '12px', display: 'flex', gap: '8px' }}>
                <input
                  type="text"
                  className="input-field"
                  style={{ flex: 1, margin: 0 }}
                  placeholder="Ask about a past lecture..."
                  value={libraryQuestion}
                  onChange={e => setLibraryQuestion(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleLibraryAsk()}
                />
                <button className="btn-primary" onClick={handleLibraryAsk} disabled={!libraryQuestion || libraryBusy}>Ask</button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'marks' && (
          <div className="animate-fade-in" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            <h2 style={{ marginBottom: '4px' }}>Marks Upload</h2>
            <p style={{ marginBottom: '20px', fontSize: '0.85rem' }}>
              Hand the agent an Excel/CSV sheet or typed marks. It'll read the data and tell you what it found — automatic LMS submission isn't wired up yet, so it won't claim to have entered anything for you.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
              <div>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>Course / section / assessment</label>
                <input
                  type="text"
                  className="input-field"
                  style={{ margin: 0 }}
                  placeholder='e.g. "OOP, Section B, Quiz 3"'
                  value={marksInstructions}
                  onChange={e => setMarksInstructions(e.target.value)}
                />
              </div>
              <div>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>Marks file (Excel / CSV)</label>
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={e => setMarksFile(e.target.files?.[0] || null)}
                />
              </div>
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' }}>Or type marks directly (Name, CMS ID, Marks — one per line)</label>
              <textarea
                className="input-field"
                style={{ width: '100%', height: '120px', resize: 'vertical' }}
                placeholder={'Ali Khan, 023-23-0213, 18/20\nSara Ahmed, 023-23-0214, 20/20'}
                value={marksText}
                onChange={e => setMarksText(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <span style={{ fontSize: '0.75rem', color: talkingToChannel ? 'var(--text-secondary)' : 'var(--danger)' }}>
                {talkingToChannel ? <>Will be sent to <strong>{channelLabel[talkingToChannel]}</strong></> : 'Link a channel in Settings first'}
              </span>
              <button className="btn-primary" onClick={handleMarksSend} disabled={(!marksText && !marksFile) || marksBusy || !talkingToChannel}>
                Send to Agent
              </button>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {marksChat.length === 0 && <p style={{ textAlign: 'center', marginTop: '20px' }}>Nothing sent yet.</p>}
              {marksChat.map((m, i) => (
                <div key={i} style={{
                  alignSelf: m.role === 'user' ? 'flex-end' : 'stretch',
                  maxWidth: m.role === 'user' ? '80%' : '100%',
                  background: m.role === 'user' ? 'var(--accent-primary)' : 'var(--bg-panel-hover)',
                  color: m.role === 'user' ? 'white' : 'var(--text-primary)',
                  padding: '10px 14px', borderRadius: '10px', fontSize: '0.9rem', whiteSpace: 'pre-wrap',
                }}>
                  {m.text}
                </div>
              ))}
              {marksBusy && <p style={{ fontSize: '0.85rem' }}>Agent is working…</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  )

  if (!configLoaded) {
    return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }} />
  }

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      {setupStep === 0 && renderWelcome()}
      {setupStep === 1 && renderOpenClawCheck()}
      {setupStep === 2 && renderAIOptions()}
      {setupStep === 3 && renderOllamaCheck()}
      {setupStep === 4 && renderCommOptions()}
      {setupStep === 5 && renderSettings()}
      {setupStep === 6 && renderMainApp()}
    </div>
  )
}
