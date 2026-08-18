const { chromium } = require('playwright');
const http = require('http');
const path = require('path');
const fs = require('fs');

// ============================================================
// AI-DRIVEN GRADES NAVIGATOR
// Zero hardcoding. AI reads dropdowns and picks the right one.
// ============================================================

const OLLAMA_BASE = 'http://127.0.0.1:11434';
const MODEL_NAME = 'minimax-m3:cloud';

function askAI(prompt, timeout = 120000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Ollama request timed out')), timeout);
        const body = JSON.stringify({ model: MODEL_NAME, prompt, stream: false });
        const req = http.request(`${OLLAMA_BASE}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                clearTimeout(timer);
                try {
                    const parsed = JSON.parse(data);
                    resolve((parsed.response || '').trim());
                } catch (e) {
                    try {
                        const lines = data.split('\n').filter(l => l.trim());
                        let full = '';
                        for (const line of lines) full += JSON.parse(line).response || '';
                        resolve(full.trim());
                    } catch (e2) {
                        reject(new Error(`Failed to parse Ollama response: ${data.substring(0, 500)}`));
                    }
                }
            });
        });
        req.on('error', (e) => { clearTimeout(timer); reject(e); });
        req.write(body);
        req.end();
    });
}

function extractValue(aiResponse) {
    let v = aiResponse.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
    v = v.replace(/^["']|["']$/g, '').trim();
    const lines = v.split('\n').map(l => l.trim()).filter(l => l);
    return lines[0] || v;
}

async function gotoRetry(page, url, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            return;
        } catch (e) {
            console.error(`[Nav] Attempt ${i + 1}/${maxRetries} failed: ${e.message}`);
            if (i < maxRetries - 1) await page.waitForTimeout(3000);
            else throw e;
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 3) {
        console.error('Usage: node ai_grades_navigator.js <CMS_ID> <PASSWORD> <natural language command>');
        process.exit(1);
    }

    const cmsId = args[0];
    const password = args[1];
    const userCommand = args.slice(2).join(' ');

    console.error(`[Nav] CMS ID: ${cmsId} | Command: "${userCommand}"`);

    const browser = await chromium.launch({ headless: false });
    const page = await (await browser.newContext()).newPage();
    const ssDir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });

    try {
        // ===== STEP 1: LOGIN =====
        console.error(`\n[Step 1] Login...`);
        await gotoRetry(page, 'http://sibagrades.iba-suk.edu.pk:86/Default.aspx');
        await page.waitForSelector('#txtuid', { timeout: 8000 });
        await page.fill('#txtuid', cmsId);
        await page.fill('#txtpwd', password);

        // Verify before clicking
        const fId = await page.inputValue('#txtuid');
        const fPw = await page.inputValue('#txtpwd');
        console.error(`[Step 1] Fields: ID="${fId}" PWD=${fPw.length}chars match=${fPw === password}`);

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
            page.click('#Button1')
        ]);
        await page.waitForTimeout(2000);

        const loginText = await page.evaluate(() => document.body.innerText);
        if (loginText.includes('Invalid') || loginText.includes('Try Again')) {
            console.error(`[Step 1] FAIL: Login rejected.`);
            await page.screenshot({ path: path.join(ssDir, 'login_failed.png'), fullPage: true });
            // Print error to stdout so user sees it in telegram
            console.log(`Failed to login: Invalid CMS ID or Password.`);
            return;
        }
        console.error(`[Step 1] OK — logged in. URL: ${page.url()}`);

        // ===== STEP 2: GO TO GRADES PAGE =====
        console.error(`\n[Step 2] Navigate to View 60 Grades...`);
        await gotoRetry(page, 'http://sibagrades.iba-suk.edu.pk:86/wpclassgraged.aspx');
        await page.waitForSelector('#ContentPlaceHolder1_Dpsemester', { timeout: 10000 });
        console.error(`[Step 2] OK — grades page loaded.`);

        // ===== STEP 3: AI PICKS SEMESTER =====
        console.error(`\n[Step 3] Reading semester dropdown...`);
        const semOpts = await page.$$eval('#ContentPlaceHolder1_Dpsemester option',
            opts => opts.map(o => ({ value: o.value, text: o.textContent.trim() }))
        );
        console.error(`[Step 3] Semesters: ${semOpts.map(o => `${o.value}="${o.text}"`).join(', ')}`);

        const semPrompt = `You are a web automation tool. User command: "${userCommand}"
Available semesters:
${semOpts.map(o => `value="${o.value}" => "${o.text}"`).join('\n')}
Reply with ONLY the numeric value of the matching semester. Nothing else.`;

        const aiSemRaw = await askAI(semPrompt);
        const aiSemVal = extractValue(aiSemRaw);
        const matchedSem = semOpts.find(o => o.value === aiSemVal) || semOpts.find(o => aiSemVal.includes(o.value));
        if (!matchedSem) {
            console.error(`[Step 3] FAIL: AI said "${aiSemVal}", no match in options.`);
            console.log(`Failed to find a matching semester for your query.`);
            return;
        }
        console.error(`[Step 3] AI picked: "${matchedSem.text}" (${matchedSem.value})`);

        // Select semester — this triggers onchange -> __doPostBack which reloads the page
        await page.selectOption('#ContentPlaceHolder1_Dpsemester', matchedSem.value);
        // Wait for the ASP.NET postback to complete and reload the page
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3000);
        await page.screenshot({ path: path.join(ssDir, '03_sem.png'), fullPage: true });

        // ===== STEP 4: AI PICKS COURSE =====
        console.error(`\n[Step 4] Reading course dropdown...`);
        await page.waitForSelector('#ContentPlaceHolder1_DpCmscourses', { timeout: 8000 });
        const courseOpts = await page.$$eval('#ContentPlaceHolder1_DpCmscourses option',
            opts => opts.map(o => ({ value: o.value, text: o.textContent.trim() }))
        );
        console.error(`[Step 4] Courses: ${courseOpts.map(o => `${o.value}="${o.text}"`).join(', ')}`);

        if (courseOpts.length === 0) {
            console.error(`[Step 4] FAIL: No courses for "${matchedSem.text}".`);
            console.log(`No courses were found for semester "${matchedSem.text}".`);
            return;
        }

        const coursePrompt = `You are a web automation tool. User command: "${userCommand}"
Available courses for ${matchedSem.text}:
${courseOpts.map(o => `value="${o.value}" => "${o.text}"`).join('\n')}
Reply with ONLY the numeric value of the matching course. Nothing else.`;

        const aiCourseRaw = await askAI(coursePrompt);
        const aiCourseVal = extractValue(aiCourseRaw);
        const matchedCourse = courseOpts.find(o => o.value === aiCourseVal) || courseOpts.find(o => aiCourseVal.includes(o.value));
        if (!matchedCourse) {
            console.error(`[Step 4] FAIL: AI said "${aiCourseVal}", no match in options.`);
            console.log(`Failed to find a matching course for your query in ${matchedSem.text}.`);
            return;
        }
        console.error(`[Step 4] AI picked: "${matchedCourse.text}" (${matchedCourse.value})`);

        await page.selectOption('#ContentPlaceHolder1_DpCmscourses', matchedCourse.value);
        await page.waitForTimeout(1000);

        // ===== STEP 5: CLICK VIEW GRADES =====
        console.error(`\n[Step 5] Clicking VIEW GRADES...`);
        await page.click('#ContentPlaceHolder1_Button1');
        // Wait for the RadGrid table to appear after postback
        await page.waitForSelector('table.rgMasterTable', { timeout: 15000 }).catch(() => {
            console.error(`[Step 5] RadGrid table not found, waiting more...`);
        });
        await page.waitForTimeout(3000);
        await page.screenshot({ path: path.join(ssDir, '05_result.png'), fullPage: true });

        // ===== STEP 6: EXTRACT GRADES DATA =====
        console.error(`\n[Step 6] Extracting grades...`);

        // Extract summary lines (Sum of Mid Term Grades, etc.)
        const summaryText = await page.evaluate(() => {
            const content = document.querySelector('#ContentPlaceHolder1_Panel1') 
                || document.querySelector('.content') 
                || document.querySelector('#content');
            return content ? content.innerText : document.body.innerText;
        });

        // Extract the RadGrid table rows specifically
        const tableData = await page.evaluate(() => {
            const rows = [];
            const table = document.querySelector('table.rgMasterTable');
            if (!table) return { rows: [], found: false };
            
            // Get headers
            const headers = [];
            table.querySelectorAll('thead th').forEach(th => headers.push(th.innerText.trim()));
            
            // Get data rows
            table.querySelectorAll('tbody tr').forEach(tr => {
                const cells = [];
                tr.querySelectorAll('td').forEach(td => cells.push(td.innerText.trim()));
                if (cells.length > 0) rows.push(cells);
            });
            
            return { headers, rows, found: true };
        });

        console.error(`[Step 6] Table found: ${tableData.found}`);
        if (tableData.found) {
            console.error(`[Step 6] Headers: ${tableData.headers.join(' | ')}`);
            tableData.rows.forEach((row, i) => console.error(`  Row ${i + 1}: ${row.join(' | ')}`));
        }

        // Build a clean data string for the AI
        let gradesDataStr = '';
        
        // Add summary info
        const summaryLines = summaryText.split('\n').filter(l => 
            l.includes('Sum') || l.includes('Final') || l.includes('Marks') || l.includes('Grade')
        );
        if (summaryLines.length > 0) {
            gradesDataStr += 'SUMMARY:\n' + summaryLines.join('\n') + '\n\n';
        }

        // Add table data
        if (tableData.found && tableData.rows.length > 0) {
            gradesDataStr += 'DETAILED GRADES TABLE:\n';
            gradesDataStr += tableData.headers.join(' | ') + '\n';
            gradesDataStr += '-'.repeat(60) + '\n';
            tableData.rows.forEach(row => { gradesDataStr += row.join(' | ') + '\n'; });
        } else {
            gradesDataStr += 'No grade records found in the table.\n';
        }

        // If we got nothing useful, fall back to full page text
        if (!gradesDataStr.includes('|') && !gradesDataStr.includes('Sum')) {
            gradesDataStr = summaryText.substring(0, 3000);
        }

        console.error(`\n[Step 6] Extracted data:\n${gradesDataStr}`);

        // ===== STEP 7: AI SUMMARIZES =====
        console.error(`\n[Step 7] Asking AI to answer...`);
        const answerPrompt = `You are helping a student check grades.
Student asked: "${userCommand}"
Semester: "${matchedSem.text}"
Course: "${matchedCourse.text}"

Extracted grades data:
---
${gradesDataStr}
---

Answer the student's question directly based on the data. State the marks/grades clearly. Be concise and friendly. DO NOT output markdown code blocks.`;

        const answer = await askAI(answerPrompt);

        // THIS IS THE ONLY THING THAT GOES TO STDOUT (which OpenClaw will send to the user)
        console.log(answer);

        await page.waitForTimeout(2000);

    } catch (err) {
        console.error(`\n[FATAL] ${err.message}`);
        console.log(`Sorry, I encountered an error while fetching your grades: ${err.message}`);
        await page.screenshot({ path: path.join(ssDir, 'error.png'), fullPage: true }).catch(() => {});
    } finally {
        await browser.close();
    }
}

main();
