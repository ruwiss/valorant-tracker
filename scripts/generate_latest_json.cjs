const fs = require('fs');
const path = require('path');

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = packageJson.version;

const nsisDir = path.join('src-tauri', 'target', 'release', 'bundle', 'nsis');
const releaseDir = 'release_output';

if (!fs.existsSync(releaseDir)) {
    fs.mkdirSync(releaseDir);
}

// Find the .exe and .exe.sig files
const files = fs.readdirSync(nsisDir);
const setupFile = files.find(f => f.includes(version) && f.endsWith('.exe') && !f.endsWith('.sig'));
const sigFile = files.find(f => f.includes(version) && f.endsWith('.exe.sig'));

if (!setupFile || !sigFile) {
    console.error(`Error: Could not find build artifacts for version ${version} in ${nsisDir}`);
    process.exit(1);
}

const signature = fs.readFileSync(path.join(nsisDir, sigFile), 'utf8').trim();
const safeSetupName = setupFile.replace(/ /g, '_');

// Copy exe to release_output if it doesn't exist or is different
fs.copyFileSync(path.join(nsisDir, setupFile), path.join(releaseDir, safeSetupName));

const latestJson = {
    version: version,
    notes: `Update for version ${version}`,
    pub_date: new Date().toISOString(),
    platforms: {
        "windows-x86_64": {
            signature: signature,
            url: `https://github.com/ruwiss/valorant-tracker/releases/latest/download/${safeSetupName}`
        }
    }
};

fs.writeFileSync(path.join(releaseDir, 'latest.json'), JSON.stringify(latestJson, null, 2));

console.log(`Successfully generated ${path.join(releaseDir, 'latest.json')}`);
console.log(`Copied installer to ${path.join(releaseDir, safeSetupName)}`);
