const path = require("node:path");

const releaseDirectory = __dirname;
const sharedDirectory =
  process.env.SOLIDCOMMUNITY_SHARED_DIR || "/home/solid/shared";
const dataDirectory =
  process.env.SOLIDCOMMUNITY_DATA_DIR ||
  "/mnt/volume_lon1_01/solidcommunity.net";
const appName = process.env.SOLIDCOMMUNITY_APP_NAME || "pivot";
const port = process.env.SOLIDCOMMUNITY_PORT || "3333";
const nodeInterpreter =
  process.env.SOLIDCOMMUNITY_NODE ||
  "/root/.nvm/versions/node/v20.18.0/bin/node";

module.exports = {
  apps: [
    {
      name: appName,
      cwd: releaseDirectory,
      script: path.join(
        releaseDirectory,
        "node_modules",
        "@solid",
        "community-server",
        "bin",
        "server.js",
      ),
      args: [
        "-c",
        path.join(releaseDirectory, "config/solidcommunity.net.json"),
        path.join(sharedDirectory, "solidcommunity.net-secrets.json"),
        "-f",
        dataDirectory,
        "-p",
        port,
        "-b",
        "https://solidcommunity.net",
        "-m",
        releaseDirectory,
        "-l",
        "info",
      ],
      interpreter: nodeInterpreter,
      node_args: ["--max-old-space-size=6144"],
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      min_uptime: "30s",
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 30000,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
