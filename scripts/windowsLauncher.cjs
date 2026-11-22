/**
 * Main script of timing.exe, the launcher of the Windows package: a Node single executable application (see
 * buildWindowsLauncher in package.mjs) with the app icon, which runs the app files beside it.
 *
 *   timing.exe [options]               Starts the timing server and opens it in the browser
 *   timing.exe diagnose [options]      Lists HID devices and helps to write triggers (run by diagnose.cmd)
 *
 * Working directory: data beside the executable, unless TIMING_WORK_DIR or --work-dir says otherwise.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

const DATA_DIR = 'data';
const packageDir = path.dirname(process.execPath);
process.env.TIMING_WORK_DIR ??= path.join(packageDir, DATA_DIR);

// argv is [timing.exe, timing.exe, ...arguments]: the scripts read their options from argv.slice(2)
const isDiagnose = process.argv[2] === 'diagnose';
if (isDiagnose) {
    process.argv.splice(2, 1);
} else {
    process.argv.splice(2, 0, '--open');
    // Double-clicked, the window would close before the error can be read
    process.on('exit', (code) => {
        if (code !== 0 && process.stdin.isTTY) spawnSync('cmd.exe', ['/d', '/c', 'pause'], { stdio: 'inherit' });
    });
}

const script = path.join(packageDir, 'app', 'backend', 'dist', ...(isDiagnose ? ['tools', 'diagnose.js'] : ['server.js']));
importModule(pathToFileURL(script).href).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

/**
 * In a single executable application, import() only loads built-in modules and require() cannot load the app (an
 * ES module with top-level await): a script compiled with the default loader can import files.
 */
function importModule(url) {
    // Its experimental warning would be the first line in the window
    const emitWarning = process.emitWarning;
    process.emitWarning = () => {};
    try {
        return new vm.Script(`import(${JSON.stringify(url)})`, {
            importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
        }).runInThisContext();
    } finally {
        process.emitWarning = emitWarning;
    }
}
