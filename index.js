const options = require("@jhanssen/options")("file-upload");
const chokidar = require("chokidar");
const path = require("path");
const fs = require("fs");
const progress = require("progress-stream");
const SSH2 = require('ssh2-promise');

const time = {
    _time: function() {
        var d = new Date();
        var hours   = d.getHours();
        var minutes = d.getMinutes();
        var seconds = d.getSeconds();

        if (hours   < 10) {hours   = "0"+hours;}
        if (minutes < 10) {minutes = "0"+minutes;}
        if (seconds < 10) {seconds = "0"+seconds;}

        return "["+hours+":"+minutes+":"+seconds+"]";
    },

    log: function(...args) {
        console.log(time._time(), ...args);
    },
    error: function(...args) {
        console.error(time._time(), ...args);
    }
};

const server = options("server");
if (!server) {
    time.error("No ssh2 server configured");
    process.exit(1);
}
const port = options.int("port", 22);
const username = options("user");
const password = options("password");
const key = options("key");
if (!username) {
    time.error("No user configured");
    process.exit(1);
}
if (!password && !key) {
    time.error("No password or key configured");
    process.exit(1);
}
const srcDir = options("srcDir");
if (!srcDir) {
    time.error("No directory to watch configured");
    process.exit(1);
}
const dstDir = options("dstDir");
if (!dstDir) {
    time.error("No directory to upload to configured");
    process.exit(1);
}
const dstSystem = options("dstSystem", "posix");
if (dstSystem !== "posix" && dstSystem != "win32") {
    time.error("Invalid dstSystem", dstSystem);
    process.exit(1);
}
const dstPath = path[dstSystem];

const matches = options("matches");
if (matches !== undefined && !(matches instanceof Array)) {
    time.error("matches needs to be undefined or an array");
    process.exit(1);
}
if (matches) {
    for (let m = 0; m < matches.length; ++m) {
        const match = matches[m];
        if (!("regexp" in match)) {
            time.error("invalid match", match);
            continue;
        }
        if (typeof match.regexp === "string") {
            try {
                match.regexp = new RegExp(match.regexp);
            } catch (e) {
                time.error("match has invalid regexp", match, e);
                delete match.regexp;
                continue;
            }
        }
        if (!(match.regexp instanceof RegExp)) {
            time.error("invalid match", match);
            delete match.regexp;
        }
    }
}

const ssh2settings = {
    host: server,
    port: port,
    username: username
};
if (key) {
    ssh2settings.identity = key;
} else {
    ssh2settings.password = password;
}

const ssh = new SSH2(ssh2settings);

class SFTP {
    constructor() {
        this.sftp = undefined;
        this.closing = undefined;
        this.timeout = options.int("timeout", 30000);
    }

    connect() {
        return new Promise((resolve, reject) => {
            if (this.sftp) {
                resolve(this.sftp);
            } else {
                if (this.closing) {
                    this.closing.then(() => {
                        this._internalConnect(resolve, reject);
                    }).catch(err => {
                        reject(err);
                    });
                } else {
                    this._internalConnect(resolve, reject);
                }
            }
        });
    }

    _internalConnect(resolve, reject) {
        ssh.connect().then(() => {
            setTimeout(() => {
                this.closing = new Promise((resolve, reject) => {
                    ssh.close().then(() => { resolve(); this.closing = undefined; }).catch(err => { reject(err); this.closing = undefined; });
                });
                this.sftp = undefined;
            }, this.timeout);
            this.sftp = ssh.sftp();
            resolve(this.sftp);
        }).catch(e => {
            reject(e);
        });
    }
}

const sftp = new SFTP();

const retries = { timer: undefined, values: [] };
const retry = (file, dst, timeout) => {
    if (!retries.timer) {
        retries.timer = setTimeout(() => {
            const v = retries.values;

            retries.timer = undefined;
            retries.values = [];

            time.log(`retrying ${v.length} files`);

            for (let n = 0; n < v.length; ++n) {
                time.log("retrying", v[n].file, v[n].dst);
                upload(v[n].file, v[n].dst, v[n].timeout);
            }
        }, timeout || 1000);
    }
    retries.values.push({ file: file, dst: dst, timeout: timeout });
};

const upload = (file, dst, timeout) => {
    sftp.connect().then(connection => {
        time.log(`connected to ${server}`);

        const fn = path.basename(file);
        let rs;
        try {
            connection.createWriteStream(dstPath.join(dst, fn)).then(ws => {
                fs.stat(file, (err, stats) => {
                    if (err) {
                        if (err.code === "EBUSY") {
                            time.log("file busy (stat), retrying", file);
                            retry(file, dst, timeout);
                        } else {
                            time.error("fs stat error", err);
                        }
                        return;
                    }
                    if (!stats.size) {
                        time.log("file empty, retrying", file);
                        retry(file, dst, timeout);
                        return;
                    }
                    const ps = progress({ length: stats.size, time: 1000 });
                    ps.on("progress", progress => {
                        time.log("progress", progress.percentage, file, dst);
                    });
                    rs = fs.createReadStream(file);
                    rs.on("error", err => {
                        if (err.code === "EBUSY") {
                            time.log("file busy (read stream), retrying", file);
                            retry(file, dst, timeout);
                        } else {
                            time.error("fs read error", err);
                        }
                        rs.destroy();
                    });
                    ws.on("finish", () => {
                        time.log("uploaded", file);
                    });
                    ws.on("error", err => {
                        time.error("sftp write error", err);
                        rs.destroy();
                    });
                    time.log("uploading", file, dst);
                    rs.pipe(ps).pipe(ws);
                });
            }).catch(e => {
                time.error("failed to upload (2)", dstPath.join(dst, fn), e);
            });
        } catch (e) {
            time.error("failed to upload (1)", file);
            if (rs) {
                rs.destroy();
            }
        }
    }).catch(err => {
        time.error("failed to connect to ssh", err);
        retry(file, dst, 60000);
    });
};

const watcher = chokidar.watch(srcDir, {
    ignoreInitial: true,
    persistent: true,
    ignored: /(^|[\/\\])\../
});
watcher.on("add", file => {
    time.log("file added", file);
    let uploaded = false;
    if (matches) {
        for (let m = 0; m < matches.length; ++m) {
            const match = matches[m];
            if (!("regexp" in match) || !("subDir" in match)) {
                time.error("invalid match", match);
                continue;
            }
            const res = match.regexp.test(file);
            if (res) {
                time.log("found match", file, match.subDir);
                upload(file, dstPath.join(dstDir, match.subDir));
                uploaded = true;
                break;
            }
        }
    }
    if (!uploaded) {
        // upload to dstDir
        upload(file, dstDir);
    }
});
