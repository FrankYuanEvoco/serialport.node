require('shelljs/global');
const gulp = require('gulp');
const fs = require('fs');
const path = require('path');
const async = require('async');
const cliArgs = require('yargs').argv;
const linuxDistro = require('linux-distro');
const github = require('octonode');
const git = require('simple-git')();

function getRepoName(gitUrl) {
    const fields = gitUrl.split(':');
    if (fields.length < 2) return '';
    const segments = fields[1].split('/');
    const userName = segments[segments.length-2];
    const repoName = segments[segments.length-1];
    const fullRepoName = `${userName}/${repoName}`;
    const position = fullRepoName.length - '.git'.length;
    const lastIndex = fullRepoName.lastIndexOf('.git');
    if (lastIndex !== -1 && lastIndex === position) {
        return fullRepoName.substring(0, position);
    } else {
        return fullRepoName;
    }
}

function uploadAssets(client, tagName, filePath, distName, callback) {
    async.waterfall([
        // parse repo name from git repository configuration
        (callback) => {
            git.listRemote(['--get-url'], function(err, data) {
                if (!err) {
                    console.log('Remote url for repository at ' + __dirname + ':');
                    const repoName = getRepoName(data.trim());
                    console.log(repoName);
                    if (repoName) {
                        callback(null, repoName);
                    } else {
                        callback('Cannot get repo name for this repository.');
                    }
                } else {
                    callback(err);
                }
            });
        },
        // get release by tag
        (repoName, callback) => {
            client.get(`/repos/${repoName}/releases/tags/${tagName}`, (err, res, body) => {
                if (!err) {
                    console.log(`release id: ${body.id}`);
                    callback(null, repoName, body.id);
                } else {
                    callback(`The release via tag ${tagName} not found!`);
                }
            });
        },
        // check if asset exist or not.
        (repoName, releaseId, callback) => {
            client.get(`/repos/${repoName}/releases/${releaseId}/assets`, (err, res, body) => {
                if (!err) {
                    const find = body.find((element) => {
                        return element.name === distName;
                    });
                    if (find) {
                        console.log(`Finded an existing asset '${distName} in github release and delete it first.`);
                        client.del(`/repos/${repoName}/releases/assets/${find.id}`, null, (err1, res1, body1) => {
                            if (err1) {
                                callback(`Cannot delete assets '${distName}'. See the error '${err1}'`);
                            } else {
                                callback(null, repoName, releaseId);
                            }
                        });
                    } else {
                        callback(null, repoName, releaseId);
                    }
                } else {
                    callback(null, repoName, releaseId, null);
                }
            });
        },
        // upload assets to releases.
        (repoName, releaseId, callback) => {
            const ghRelease = client.release(repoName, releaseId);
            const archive = fs.readFileSync(filePath);
            ghRelease.uploadAssets(archive, {
                name: distName,
                contentType: 'application/octet-stream',
                uploadHost: 'uploads.github.com',
            }, (err, res, body) => {
                if (!err) {
                    console.log(`Succeeded to upload assets '${distName}' to github release '${tagName}'`);
                }
                callback(err);
            });
        }
    ], (error, results) => {
        callback(error);
    });
}

function getNodeNameAndUploadAssets(libraryName, electron, arch, client, tagName, filePath, callback) {
    const platform = require('os').platform();

    if (platform == "linux") {
        linuxDistro().then(data => {
            const packageName = `${libraryName}_${data.os}${data.release || data.code}_${electron}_${arch}.node`;
            console.log(`package name: ${packageName}`);
            uploadAssets(client, tagName, filePath, packageName, callback);
        }, () => {
            const packageName = `${libraryName}_${platform}_${electron}_${arch}.node`;
            console.log(`package name: ${packageName}`);
            uploadAssets(client, tagName, filePath, packageName, callback);
        });
    } else {
        const packageName = `${libraryName}_${platform}_${electron}_${arch}.node`;
        console.log(`package name: ${packageName}`);
        uploadAssets(client, tagName, filePath, packageName, callback);
    }
}

gulp.task('build', (done)=> {
    if (!cliArgs.electron ||  !cliArgs.tag) {
        done('Missing electron version, tag parameters!');
        return ;
    }
    // const client = github.client(cliArgs.token);
    const tagName = cliArgs.tag;
    const electron = cliArgs.electron;

    const archs = ["x64"];
    const platform = require('os').platform();

    const tasks = [];
    async.waterfall([
        (callback) => {
        for (const arch of archs) {
            if (platform == "linux" && arch == "ia32") {
                console.log("Skipping task when arch = ia32, platform = linux since node 10 is not supported for this combination.");
                continue;
            }

            const rebuildCommand = `node-gyp rebuild --target=${electron} --arch=${arch} --dist-url=https://atom.io/download/electron`;

            tasks.push((callback) => {
                const detectionPath = "./node_modules/usb-detection";
                const detectionNodePath = path.normalize(path.join(__dirname, detectionPath, 'build/Release/detection.node'));
                console.log(`[node-gyp] Starting to build usb-detection binary version for electron ${electron} and arch ${arch}.`);
                const compile = exec(`${rebuildCommand}`, {cwd: path.join(__dirname, path.normalize(detectionPath))});
                if (compile.code) {
                    callback('[node-gyp] Compiling usb-detection native code failed.');
                } else {
                    console.log(`[node-gyp] Build complete.Generate dll at ${detectionNodePath}`);
                    // getNodeNameAndUploadAssets("detector", electron, arch, client, tagName, detectionNodePath, callback);
                }
            });

            tasks.push((callback) => {
                const serialportPath = "./node_modules/@serialport/bindings";
                const serialportNodePath = path.normalize(path.join(serialportPath, 'build/Release/bindings.node'));
                console.log(`[node-gyp] Starting to build serialport binary version for electron ${electron} and arch ${arch}.`);
                const compile = exec(`${rebuildCommand}`, {cwd: path.normalize(serialportPath)});
                if (compile.code) {
                    callback('[node-gyp] Compiling serialport native code failed.');
                } else {
                    console.log(`[node-gyp] Build complete.Generate dll at ${serialportNodePath}`);
                    // getNodeNameAndUploadAssets("serialport", electron, arch, client, tagName, serialportNodePath, callback);
                }
            });
        }
        async.series(tasks, callback);
        },
    ], (error, result) => {
        done(error);
    });
});
