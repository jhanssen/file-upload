const options = require("@jhanssen/options")("file-upload");
const chokidar = require("chokidar");
const path = require("path");
const fs = require("fs");
const SSH2 = require('ssh2-promise');

const server = options("server");
if (!server) {
    console.error("No ssh2 server configured");
    process.exit(1);
}
const port = options.int("port", 22);
const username = options("user");
const password = options("password");
const key = options("key");
if (!username) {
    console.error("No user configured");
    process.exit(1);
}
if (!password && !key) {
    console.error("No password or key configured");
    process.exit(1);
}
const srcDir = options("srcDir");
if (!srcDir) {
    console.error("No directory to watch configured");
    process.exit(1);
}
const dstDir = options("dstDir");
if (!dstDir) {
    console.error("No directory to upload to configured");
    process.exit(1);
}
const dstSystem = options("dstSystem", "posix");
if (dstSystem !== "posix" && dstSystem != "win32") {
    console.error("Invalid dstSystem", dstSystem);
    process.exit(1);
}
const dstPath = path[dstSystem];

const matches = options("matches");
if (matches !== undefined && !(matches instanceof Array)) {
    console.error("matches needs to be undefined or an array");
    process.exit(1);
}
if (matches) {
    for (let m = 0; m < matches.length; ++m) {
        const match = matches[m];
        if (!("regexp" in match)) {
            console.error("invalid match", match);
            continue;
        }
        if (typeof match.regexp === "string") {
            try {
                match.regexp = new RegExp(match.regexp);
            } catch (e) {
                console.error("match has invalid regexp", match, e);
                delete match.regexp;
                continue;
            }
        }
        if (!(match.regexp instanceof RegExp)) {
            console.error("invalid match", match);
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

(async function() {
    await ssh.connect();
    console.log(`connected to ${server}, getting sftp session`);
    const sftp = ssh.sftp();

    const retries = { timer: undefined, values: [] };
    const retry = (file, dst) => {
        if (!retries.timer) {
            retries.timer = setTimeout(() => {
                const v = retries.values;

                retries.timer = undefined;
                retries.values = [];

                for (let n = 0; n < v.length; ++n) {
                    upload(v[n].file, v[n].dst);
                }
            }, 1000);
        }
        retries.values.push({ file: file, dst: dst });
    };

    const upload = (file, dst) => {
        const fn = path.basename(file);
        let rs, ws;
        try {
            sftp.createWriteStream(dstPath.join(dst, fn)).then(ws => {
                rs = fs.createReadStream(file);
                rs.on("error", err => {
                    if (err.code === "EBUSY") {
                        retry(file, dst);
                    } else {
                        console.error("fs read error", err);
                    }
                    rs.destroy();
                });
                ws.on("finish", () => {
                    console.log("uploaded", file);
                });
                console.log("uploading", file);
                rs.pipe(ws);
            }).catch(e => {
                console.error("failed to upload", dstPath.join(dst, fn), e);
            });
        } catch (e) {
            console.error("failed to upload", file);
            if (rs) {
                rs.destroy();
            }
        }
    };

    const watcher = chokidar.watch(srcDir, {
        ignoreInitial: true,
        persistent: true,
        ignored: /(^|[\/\\])\../
    });
    watcher.on("add", file => {
        console.log("file added", file);
        if (matches) {
            for (let m = 0; m < matches.length; ++m) {
                const match = matches[m];
                if (!("regexp" in match) || !("subDir" in match)) {
                    console.error("invalid match", match);
                    continue;
                }
                const res = match.regexp.test(file);
                if (res) {
                    console.log("found match", file, match.subDir);
                    upload(file, dstPath.join(dstDir, match.subDir));
                    break;
                }
            }
        } else {
            // upload to dstDir
            upload(file, dstDir);
        }
    });
})();
