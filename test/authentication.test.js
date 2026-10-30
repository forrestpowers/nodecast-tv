const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

async function serverFixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-auth-test-'));
    const root = path.join(__dirname, '..');
    let child, base;
    const stop = async () => {
        if (!child || child.exitCode !== null) return;
        const closed = new Promise(resolve => child.once('close', resolve));
        child.kill();
        await closed;
    };
    const start = async () => {
        child = spawn(process.execPath, ['server/index.js'], { cwd: root,
            env: { ...process.env, PORT: '0', NODECAST_DATA_DIR: dir,
                NODECAST_DISABLE_BACKGROUND_JOBS: 'true', JWT_SECRET: '', SESSION_SECRET: '',
                OIDC_ISSUER_URL: '', ALLOW_LOCAL_MEDIA_URLS: 'true', AUTH_COOKIE_SECURE: 'false' },
            stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        base = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 15000);
            child.stdout.on('data', chunk => {
                output += chunk;
                const match = output.match(/server running on http:\/\/localhost:(\d+)/);
                if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
            });
            child.stderr.on('data', chunk => { output += chunk; });
            child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
            child.once('error', reject);
        });
        return base;
    };
    t.after(async () => {
        await stop();
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    await start();
    const request = async (endpoint, options = {}) => {
        const response = await fetch(`${base}${endpoint}`, { ...options,
            headers: { 'Content-Type': 'application/json', ...options.headers } });
        const body = await response.text();
        return { status: response.status, body: body ? JSON.parse(body) : null,
            cookie: response.headers.getSetCookie().find(value => value.startsWith('nodecast_auth_')),
            headers: response.headers };
    };
    return { dir, request, start, stop, get base() { return base; } };
}
const post = body => ({ method: 'POST', body: JSON.stringify(body) });

test('real application authenticates cookies and bearer clients, isolates users, and persists revocation', async t => {
    const fixture = await serverFixture(t);
    const { request } = fixture;
    for (const route of ['/api/sources', '/api/proxy/stream?url=http://provider.test/a', '/api/probe',
        '/api/remux', '/api/subtitle', '/api/transcode/sessions', '/api/settings', '/api/history']) {
        assert.equal((await request(route)).status, 401, route);
    }
    const attempts = await Promise.all(['Admin', 'Other'].map(username => request('/api/auth/setup', post({ username, password: 'password123' }))));
    assert.equal(attempts.filter(result => result.status === 201).length, 1);
    const admin = attempts.find(result => result.status === 201);
    const cookie = admin.cookie.split(';')[0];
    assert.match(admin.cookie, /HttpOnly/);
    assert.match(admin.cookie, /SameSite=Lax/);
    assert.equal(admin.body.user.passwordHash, undefined);
    const adminHeaders = { Cookie: cookie };
    assert.equal((await request('/api/sources', { headers: adminHeaders })).status, 200);
    assert.equal((await request('/api/auth/me', { headers: { Authorization: `Bearer ${admin.body.token}` } })).status, 200);
    const viewer = await request('/api/auth/users', { ...post({ username: 'Viewer', password: 'password123', role: 'viewer' }), headers: adminHeaders });
    assert.equal(viewer.status, 201);
    const login = await request('/api/auth/login', post({ username: 'Viewer', password: 'password123' }));
    const viewerCookie = login.cookie.split(';')[0];
    const viewerHeaders = { Cookie: viewerCookie };
    assert.equal((await request('/api/auth/me', { headers: viewerHeaders })).body.role, 'viewer');
    for (const [route, method] of [['/api/settings', 'PUT'], ['/api/channels/hide', 'POST'], ['/api/auth/users', 'GET']]) {
        assert.equal((await request(route, { method, headers: viewerHeaders, body: method === 'GET' ? undefined : '{}' })).status, 403, route);
    }
    assert.equal((await request('/api/settings', { headers: viewerHeaders })).status, 200);
    assert.equal((await request('/api/remux?url=file:///etc/passwd', { headers: viewerHeaders })).status, 400);
    assert.equal((await request('/api/probe?url=file:///etc/passwd', { headers: viewerHeaders })).status, 400);
    assert.equal((await request('/api/transcode', { headers: viewerHeaders })).status, 400);
    for (const route of ['/api/transcode?url=file:///etc/passwd', '/api/proxy/image?url=http://169.254.169.254/a',
        '/api/subtitle?url=file:///etc/passwd&index=0']) assert.equal((await request(route, { headers: viewerHeaders })).status, 400, route);
    assert.equal((await request('/api/auth/session', { method: 'POST', headers: { Authorization: `Bearer ${login.body.token}` } })).status, 200);
    assert.equal((await request('/api/auth/logout', { method: 'POST', headers: viewerHeaders })).status, 200);
    assert.equal((await request('/api/auth/me', { headers: viewerHeaders })).status, 401);
    const secrets = fs.readFileSync(path.join(fixture.dir, 'security.json'), 'utf8');
    await fixture.stop(); await fixture.start();
    assert.equal(fs.readFileSync(path.join(fixture.dir, 'security.json'), 'utf8'), secrets);
    assert.equal((await request('/api/auth/me', { headers: viewerHeaders })).status, 401);
    assert.equal((await request('/api/auth/me', { headers: adminHeaders })).status, 200);
    const secret = JSON.parse(secrets).jwt;
    const invalid = jwt.sign({ id: admin.body.user.id, role: 'admin', kind: 'mfa' }, secret,
        { audience: 'nodecast-tv', expiresIn: '5m', jwtid: 'temporary' });
    assert.equal((await request('/api/auth/me', { headers: { Authorization: `Bearer ${invalid}` } })).status, 401);
    const nextLogin = await request('/api/auth/login', post({ username: 'Viewer', password: 'password123' }));
    assert.equal(nextLogin.status, 200);
    assert.equal((await request(`/api/auth/users/${viewer.body.id}`, { method: 'PUT', body: JSON.stringify({ password: 'changed123' }), headers: adminHeaders })).status, 200);
    assert.equal((await request('/api/auth/me', { headers: { Authorization: `Bearer ${nextLogin.body.token}` } })).status, 401);
});

test('cross-site requests and spoofed forwarded hosts are blocked, and login attempts are bounded', async t => {
    const { request, base } = await serverFixture(t);
    assert.equal((await request('/api/auth/setup', { ...post({ username: 'Admin', password: 'password123' }),
        headers: { Origin: 'https://untrusted.test', 'X-Forwarded-Host': 'untrusted.test' } })).status, 403);
    assert.equal((await request('/api/auth/setup', { ...post({ username: 'Admin', password: 'password123' }), headers: { Origin: base } })).status, 201);
    assert.equal((await request('/api/sources', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await request('/api/auth/login', { ...post({ username: 'Admin', password: 'password123' }), headers: { Origin: 'null' } })).status, 403);
    for (let i = 0; i < 19; i++) assert.equal((await request('/api/auth/login', post({ username: 'Nobody', password: 'wrong' }))).status, 401);
    const limited = await request('/api/auth/login', post({ username: 'Nobody', password: 'wrong' }));
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('Retry-After')) > 0);
});

test('separate installations reject each other\'s cookies even when user IDs match', async t => {
    const first = await serverFixture(t), second = await serverFixture(t);
    const one = await first.request('/api/auth/setup', post({ username: 'Admin', password: 'password123' }));
    const two = await second.request('/api/auth/setup', post({ username: 'Admin', password: 'password123' }));
    assert.equal(one.body.user.id, two.body.user.id);
    assert.notEqual(one.cookie.split('=')[0], two.cookie.split('=')[0]);
    assert.equal((await second.request('/api/auth/me', { headers: { Cookie: one.cookie.split(';')[0] } })).status, 401);
    assert.equal((await first.request('/api/auth/me', { headers: { Cookie: two.cookie.split(';')[0] } })).status, 401);
});

function ffmpegBinary() {
    if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) return 'ffmpeg';
    try { const binary = require('ffmpeg-static'); if (binary && fs.existsSync(binary)) return binary; } catch {}
    return null;
}
const ffmpeg = ffmpegBinary();
test('real authenticated media requests deliver remux and owned HLS output without premature cleanup', { skip: ffmpeg ? false : 'FFmpeg unavailable' }, async t => {
    const fixture = await serverFixture(t);
    const admin = await fixture.request('/api/auth/setup', post({ username: 'Admin', password: 'password123' }));
    const adminHeaders = { Cookie: admin.cookie.split(';')[0] };
    await fixture.request('/api/auth/users', { ...post({ username: 'Viewer', password: 'password123', role: 'viewer' }), headers: adminHeaders });
    const viewer = await fixture.request('/api/auth/login', post({ username: 'Viewer', password: 'password123' }));
    const headers = { Cookie: viewer.cookie.split(';')[0] };
    const sample = path.join(fixture.dir, 'sample.ts');
    const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10', '-f', 'lavfi', '-i', 'sine=sample_rate=48000',
        '-t', '12', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-g', '20', '-c:a', 'libmp3lame', '-f', 'mpegts', sample], { encoding: 'utf8', timeout: 15000 });
    assert.equal(generated.status, 0, generated.stderr);
    const bytes = fs.readFileSync(sample);
    const origin = http.createServer((req, res) => { res.setHeader('Content-Length', bytes.length); res.end(bytes); });
    await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { origin.close(resolve); origin.closeAllConnections(); }));
    const url = `http://127.0.0.1:${origin.address().port}/sample.ts`;
    const remux = await fetch(`${fixture.base}/api/remux?url=${encodeURIComponent(url)}&audioCodecs=mp3`, { headers, signal: AbortSignal.timeout(10000) });
    assert.equal(remux.status, 200);
    const media = Buffer.from(await remux.arrayBuffer());
    assert.ok(media.includes(Buffer.from('ftyp')));
    assert.ok(media.includes(Buffer.from('mdat')));
    const lease = 'real_fixture_playback_lease';
    const session = await fixture.request('/api/transcode/session', { ...post({ url, videoMode: 'copy', videoCodec: 'h264', playbackLeaseId: lease }), headers });
    assert.equal(session.status, 200, JSON.stringify(session.body));
    const playlist = await fetch(`${fixture.base}${session.body.playlistUrl}`, { headers });
    assert.equal(playlist.status, 200);
    const text = await playlist.text(), segment = text.split(/\r?\n/).find(line => /^seg\d+\.ts$/.test(line));
    assert.ok(segment, text);
    const file = await fetch(`${fixture.base}/api/transcode/${session.body.sessionId}/${segment}`, { headers });
    assert.equal(file.status, 200);
    assert.match(file.headers.get('Cache-Control'), /private/);
    assert.ok((await file.arrayBuffer()).byteLength > 0);
    assert.equal((await fetch(`${fixture.base}${session.body.playlistUrl}`, { headers: adminHeaders })).status, 404);
    assert.equal((await fixture.request('/api/transcode/lease', { ...post({ playbackLeaseId: lease }), method: 'DELETE', headers })).status, 200);
    assert.equal((await fetch(`${fixture.base}${session.body.playlistUrl}`, { headers })).status, 404);
});

test('local login matches case variants and preserves account IDs, roles, passwords and display spelling', async t => {
    const { request } = await serverFixture(t);
    const admin = await request('/api/auth/setup', post({ username: 'Owner', password: 'owner-password' }));
    assert.equal(admin.status, 201);
    const headers = { Cookie: admin.cookie.split(';')[0] };
    const viewer = await request('/api/auth/users', { ...post({ username: 'Viewer', password: 'viewer-password', role: 'viewer' }), headers });
    assert.equal(viewer.status, 201);
    for (const username of ['viewer', 'VIEWER', 'vIeWeR']) {
        const login = await request('/api/auth/login', post({ username, password: 'viewer-password' }));
        assert.equal(login.status, 200);
        assert.deepEqual(login.body.user, { id: viewer.body.id, username: 'Viewer', role: 'viewer' });
    }
    assert.equal((await request('/api/auth/login', post({ username: 'viewer', password: 'VIEWER-PASSWORD' }))).status, 401);
    assert.equal((await request('/api/auth/login', post({ username: 'owner', password: 'viewer-password' }))).status, 401);
    assert.equal((await request('/api/auth/users', { ...post({ username: 'VIEWER', password: 'another-password', role: 'admin' }), headers })).status, 500);
    assert.equal((await request(`/api/auth/users/${viewer.body.id}`, { method: 'PUT', body: JSON.stringify({ username: 'OWNER' }), headers })).status, 500);
    assert.equal((await request(`/api/auth/users/${viewer.body.id}`, { method: 'PUT', body: JSON.stringify({ username: 'VIEWER' }), headers })).status, 200);
    const renamed = await request('/api/auth/login', post({ username: 'viewer', password: 'viewer-password' }));
    assert.equal(renamed.body.user.id, viewer.body.id); assert.equal(renamed.body.user.username, 'VIEWER');
});

test('legacy case-only accounts retain exact logins and reject ambiguous case variants until renamed', async t => {
    const fixture = await serverFixture(t);
    await fixture.request('/api/auth/setup', post({ username: 'Admin', password: 'admin-password' }));
    await fixture.stop();
    const filename = path.join(fixture.dir, 'db.json'), data = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const bcrypt = require('bcryptjs');
    data.users.push({ id: data.nextId++, username: 'Twin', role: 'admin', passwordHash: await bcrypt.hash('first-password', 4) },
        { id: data.nextId++, username: 'twin', role: 'viewer', passwordHash: await bcrypt.hash('second-password', 4) });
    fs.writeFileSync(filename, JSON.stringify(data)); await fixture.start();
    for (const [username, password, role] of [['Twin', 'first-password', 'admin'], ['twin', 'second-password', 'viewer']]) {
        const login = await fixture.request('/api/auth/login', post({ username, password }));
        assert.equal(login.status, 200); assert.equal(login.body.user.role, role);
    }
    assert.equal((await fixture.request('/api/auth/login', post({ username: 'TWIN', password: 'first-password' }))).status, 401);
    assert.equal((await fixture.request('/api/auth/login', post({ username: 'Twin', password: 'second-password' }))).status, 401);
    const owner = await fixture.request('/api/auth/login', post({ username: 'admin', password: 'admin-password' }));
    const headers = { Cookie: owner.cookie.split(';')[0] }, lower = data.users.find(user => user.username === 'twin');
    assert.equal((await fixture.request(`/api/auth/users/${lower.id}`, { method: 'PUT', body: JSON.stringify({ username: 'twin', password: 'changed-password' }), headers })).status, 200);
    assert.equal((await fixture.request(`/api/auth/users/${lower.id}`, { method: 'PUT', body: JSON.stringify({ username: 'TWIN' }), headers })).status, 500);
    assert.equal((await fixture.request(`/api/auth/users/${lower.id}`, { method: 'PUT', body: JSON.stringify({ username: 'Other' }), headers })).status, 200);
    const resolved = await fixture.request('/api/auth/login', post({ username: 'TWIN', password: 'first-password' }));
    assert.equal(resolved.status, 200); assert.equal(resolved.body.user.username, 'Twin');
});

test('recorded TS movies and series use copy sessions, preserve totals and seek on a provider without ranges',
    { skip: process.env.NODECAST_BROWSER_TESTS === '1' ? false : 'Browser tests enabled in CI', timeout: 90000 }, async t => {
        const { chromium }=require('playwright');
        const fixture=await serverFixture(t);
        const binary=spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status===0?'ffmpeg':require('ffmpeg-static');
        const recorded=path.join(fixture.dir,'recorded.ts');
        const generated=spawnSync(binary,['-hide_banner','-loglevel','error','-y',
            '-f','lavfi','-i','color=c=red:s=160x90:r=10:d=12','-f','lavfi','-i','color=c=blue:s=160x90:r=10:d=12',
            '-f','lavfi','-i','sine=frequency=1000:sample_rate=48000:duration=24',
            '-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]','-map','[v]','-map','2:a',
            '-c:v','libx264','-threads','1','-preset','ultrafast','-g','10','-c:a','aac','-ac','2','-f','mpegts',recorded],{encoding:'utf8',timeout:15000});
        assert.equal(generated.status,0,generated.stderr);
        const media=fs.readFileSync(recorded),provider=http.createServer((req,res)=>{
            // This origin always ignores Range and sends the full recording progressively.
            res.writeHead(200,{'Content-Type':'video/mp2t'});res.write(media);res.end();
        });
        await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
        t.after(()=>new Promise(resolve=>{provider.close(resolve);provider.closeAllConnections();}));
        const source=`http://127.0.0.1:${provider.address().port}/recorded.ts`;
        const admin=await fixture.request('/api/auth/setup',post({username:'Owner',password:'owner-password'}));assert.equal(admin.status,201);
        const cookie=admin.cookie.split(';')[0],headers={Cookie:cookie};
        const browser=await chromium.launch({headless:true,executablePath:process.env.NODECAST_BROWSER_EXECUTABLE||undefined});t.after(()=>browser.close());
        const context=await browser.newContext();const split=cookie.indexOf('=');
        await context.addCookies([{name:cookie.slice(0,split),value:cookie.slice(split+1),url:fixture.base}]);
        const page=await context.newPage(),requests=[],errors=[];
        page.on('pageerror',error=>errors.push(error.message));
        page.on('request',request=>{if(request.url().includes('/api/transcode/session'))requests.push(JSON.parse(request.postData()));});
        await page.route('https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js',route=>route.fulfill({contentType:'application/javascript',body:fs.readFileSync(require.resolve('hls.js/dist/hls.min.js'))}));
        await page.route('https://fonts.**',route=>route.abort());
        await page.route('**/api/probe?**',async route=>{const response=await route.fetch();const info=await response.json();await route.fulfill({response,json:{...info,duration:0}});});
        await page.goto(fixture.base);await page.waitForFunction(()=>window.app?.pages?.watch);
        for(const [type,settings]of [['movie',{autoTranscode:true,forceRemux:false}],['series',{autoTranscode:false,forceRemux:true}]]){
            await fixture.request('/api/settings',{method:'PUT',headers,body:JSON.stringify(settings)});
            await page.evaluate(async({source,type})=>{
                const watch=window.app.pages.watch;window.app.navigateTo('watch');
                watch.content={type};watch.resumeTime=0;await watch.loadVideo(source);
            },{source,type});
            await page.waitForFunction(()=>window.app.pages.watch.currentSessionId&&window.app.pages.watch.video.readyState>=2&&window.app.pages.watch.sourceDuration>20);
            const original=await page.evaluate(()=>({session:window.app.pages.watch.currentSessionId,total:window.app.pages.watch.getPlaybackDuration()}));
            assert.ok(original.total>23&&original.total<26,JSON.stringify(original));
            assert.equal(requests.at(-1).videoMode,'copy');assert.equal(requests.at(-1).isLive,false);
            const pixel=()=>page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;canvas.getContext('2d').drawImage(window.app.pages.watch.video,0,0,1,1);return Array.from(canvas.getContext('2d').getImageData(0,0,1,1).data);});
            let color=await pixel();assert.ok(color[0]>color[2]+100,JSON.stringify(color));
            await page.evaluate(()=>window.app.pages.watch.seekToContentTime(16));
            await page.waitForFunction(old=>window.app.pages.watch.currentSessionId!==old&&window.app.pages.watch.video.readyState>=2,original.session);
            color=await pixel();assert.ok(color[2]>color[0]+100,JSON.stringify(color));
            assert.equal(requests.at(-1).seekOffset,16);
            assert.equal(await page.evaluate(()=>window.app.pages.watch.getPlaybackDuration()),original.total);
            const forward=await page.evaluate(()=>window.app.pages.watch.currentSessionId);
            assert.equal((await fixture.request(`/api/transcode/${original.session}/stream.m3u8`,{headers})).status,404);
            await page.evaluate(()=>window.app.pages.watch.seekToContentTime(4));
            await page.waitForFunction(old=>window.app.pages.watch.currentSessionId!==old&&window.app.pages.watch.video.readyState>=2,forward);
            color=await pixel();assert.ok(color[0]>color[2]+100,JSON.stringify(color));
            assert.equal(requests.at(-1).seekOffset,4);
            assert.equal(await page.evaluate(()=>window.app.pages.watch.getPlaybackDuration()),original.total);
            await page.evaluate(()=>window.app.pages.watch.stop());
        }
        assert.deepEqual(errors,[]);await page.close();
    });
