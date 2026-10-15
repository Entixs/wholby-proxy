#!/usr/bin/env node
// Sets (or changes) the admin dashboard password.
//
//   npm run admin-password
//
// The password is stored only as a salted hash in data/admin.json. Changing it signs everyone out of the dashboard.
// For scripts: echo "the-password" | npm run admin-password -- --password-stdin

const path = require('path');
const { savePassword } = require('../admin');

const dataDir = path.dirname(process.env.TOKEN_FILE || path.join(__dirname, '..', 'data', 'tokens.json'));
const MIN_LENGTH = 12;

const readHidden = (prompt) => new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk) => {
        for (const ch of chunk) {
            if (ch === '\r' || ch === '\n' || ch === '\u0004') {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener('data', onData);
                process.stdout.write('\n');
                return resolve(value);
            }
            if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
            if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
            else value += ch;
        }
    };
    stdin.on('data', onData);
});

const readStdin = () => new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
});

const problem = (password) => {
    if (password.length < MIN_LENGTH) return `The password must be at least ${MIN_LENGTH} characters.`;
    if (password.length > 200) return 'The password is too long (200 characters at most).';
    if (new Set(password).size < 4) return 'The password is too repetitive.';
    return null;
};

(async () => {
    let password;
    if (process.argv.includes('--password-stdin')) {
        password = await readStdin();
    } else if (process.stdin.isTTY) {
        console.log(`Set the admin dashboard password (at least ${MIN_LENGTH} characters). Nothing is shown while you type.`);
        password = await readHidden('New password: ');
        const again = await readHidden('Repeat it:   ');
        if (password !== again) { console.error('The two passwords do not match. Nothing was changed.'); process.exit(1); }
    } else {
        console.error('Run this in a terminal, or pipe the password in with --password-stdin.');
        process.exit(1);
    }
    const bad = problem(password);
    if (bad) { console.error(`${bad} Nothing was changed.`); process.exit(1); }
    savePassword(dataDir, password);
    console.log(`Done. The password is saved (as a hash) in ${path.join(dataDir, 'admin.json')}.`);
    console.log('Everyone is signed out of the dashboard. Open it on the port set in ADMIN_PORT.');
})();
