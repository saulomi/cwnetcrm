module.exports = {
  apps: [
    {
      name: "wacrm",
      script: "cmd.exe",
      args: ["/c", "npm", "run", "dev"],
      cwd: __dirname,
      interpreter: "none",
      watch: false,
    },
  ],
}
