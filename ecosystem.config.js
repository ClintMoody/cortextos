module.exports = {
  "apps": [
    {
      "name": "cortextos-daemon",
      "script": "/Users/cortextos/cortextos-test/dist/daemon.js",
      "args": "--instance e2e-test",
      "cwd": "/Users/cortextos/cortextos-test",
      "env": {
        "CTX_INSTANCE_ID": "e2e-test",
        "CTX_ROOT": "/Users/cortextos/.cortextos/e2e-test",
        "CTX_FRAMEWORK_ROOT": "/Users/cortextos/cortextos-test",
        "CTX_PROJECT_ROOT": "/Users/cortextos/cortextos-test",
        "CTX_ORG": "acme"
      },
      "max_restarts": 10,
      "restart_delay": 5000,
      "autorestart": true
    }
  ]
};
