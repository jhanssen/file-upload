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

const debugStream = options("debugStream");

const matches = options("matches");
if (matches !== undefined && !(matches instanceof Array)) {
    time.error("matches needs to be undefined or an array");
    process.exit(1);
}

const reconnectTimeout = options.int("reconnect-timeout", 30000);
const reuploadTimeout = options.int("reupload-timeout", 60000 * 10);

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

class Connection {
    constructor() {
        this.ssh = undefined;
        this.sftp = undefined;
    }

    connect() {
        return new Promise((resolve, reject) => {
            if (this.ssh && this.sftp) {
                resolve({ sftp: this.sftp, ssh: this.ssh });
            } else {
                this._internalConnect(resolve, reject);
            }
        });
    }

    _internalConnect(resolve, reject) {
        if (this.ssh === undefined)
            this.ssh = new SSH2(ssh2settings);
        this.ssh.connect().then(() => {
            setTimeout(() => {
                this.sftp = undefined;
                this.ssh = undefined;
            }, reconnectTimeout);
            this.sftp = this.ssh.sftp();
            resolve({ sftp: this.sftp, ssh: this.ssh });
        }).catch(e => {
            reject(e);
        });
    }
}

const connection = new Connection();

const uploads = {
    _uploads: [],
    _connection: undefined,

    init: function() {
        setInterval(() => {
            if (this._uploads.length > 0 && this._uploads[0].stream !== undefined) {
                const delta = Date.now() - this._uploads[0].stream.ts;
                if (delta >= 30000) {
                    time.log("still uploading", this._uploads[0].file);
                }
                if (delta >= reuploadTimeout) {
                    this._uploads[0].stream.reject(`upload timeout ${this._uploads[0].file}`);
                }
            }
        }, 10000);
    },

    add: function(file, dst) {
        this._uploads.push({ file: file, dst: dst });
        if (!this._connection) {
            connection.connect().then(c => {
                this._connection = c;
                this._next();

                setTimeout(() => {
                    this._connection = undefined;
                }, reconnectTimeout);
            });
        } else {
            this._next();
        }
    },

    _next: function() {
        if (this._uploads.length === 0)
            return;
        this._upload().then(() => {
            console.log("upload complete", this._uploads[0].file);
            this._uploads.splice(0, 1);
            this._next();
        }).catch(err => {
            console.log("upload failed", err);
            if (this._uploads[0].stream) {
                this._uploads[0].stream.rs.destroy();
                delete this._uploads[0].stream;
            }
            this._retryLater();
        });
    },

    _retryLater: function() {
        setTimeout(() => {
            this._next();
        }, 60000);
    },

    _upload: function() {
        return new Promise((resolve, reject) => {
            const upload = this._uploads[0];
            const file = upload.file;
            const dst = upload.dst;

            const fn = path.basename(file);
            let rs;
            try {
                const wsOptions = {
                    flags: "w",
                    encoding: null,
                    mode: 0o666,
                    autoClose: true
                };
                if (debugStream)
                    wsOptions.debug = console.log;
                this._connection.sftp.createWriteStream(dstPath.join(dst, fn), wsOptions).then(ws => {
                    fs.stat(file, (err, stats) => {
                        if (err) {
                            if (err.code === "EBUSY") {
                                reject(`file busy (stat), retrying ${file}`);
                            } else {
                                reject(`fs stat error ${file}, ${err}`);
                            }
                            return;
                        }
                        if (!stats.size) {
                            reject(`file empty, retrying ${file}`);
                            return;
                        }
                        const ps = progress({ length: stats.size, time: 1000 });
                        ps.on("progress", progress => {
                            time.log("progress", progress.percentage, file, dst);
                        });
                        rs = fs.createReadStream(file);
                        rs.on("error", err => {
                            if (err.code === "EBUSY") {
                                reject(`file busy (read stream), retrying ${file}`);
                            } else {
                                reject(`fs read error ${file} ${err}`);
                            }
                        });
                        ws.on("error", err => {
                            reject(`sftp write error ${file} ${err}`);
                        });
                        ws.on("finish", () => {
                            resolve(`finished uploading ${file}`);
                        });
                        upload.stream = { rs: rs, ws: ws, ps: ps, ts: Date.now(), resolve: resolve, reject: reject };
                        rs.pipe(ps).pipe(ws);
                    });
                }).catch(e => {
                    reject(`failed to upload (2) ${dstPath.join(dst, fn)}, ${e}`);
                });
            } catch (e) {
                reject(`failed to upload (1) ${file} ${e}`);
            }
        });
    }
};

uploads.init();

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
                uploads.add(file, dstPath.join(dstDir, match.subDir));
                uploaded = true;
                break;
            }
        }
    }
    if (!uploaded) {
        // upload to dstDir
        uploads.add(file, dstDir);
    }
});
