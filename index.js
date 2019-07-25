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

const matches = options.json("matches");
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
    const sftp = ssh.sftp();

    const upload = (file, dst) => {
        const fn = path.basename(file);
        try {
            const ws = sftp.createWriteStream(dstPath.join(dst, fn));
            const rs = fs.createReadStream(file);
            rs.pipe(ws);
        } catch (e) {
            console.error("failed to upload", file, dstPath.join(dst, fn), e);
        }
    };

    const watcher = chokidar.watch(srcDir, {
        ignoreInitial: true,
        persistent: true,
        ignored: /(^|[\/\\])\../
    });
    watcher.on("add", file => {
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
