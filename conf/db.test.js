const { spawnSync } = require("node:child_process");
const path = require("node:path");

const configPath = path.join(__dirname, "db.js");
const configEnv = {
  NODE_ENV: "container-config-test",
  DB_HOST: "mysql.internal",
  DB_USER: "test-user",
  DB_PASS: "test-password",
  DB_PORT: "3306",
  DB_Name: "test-fund",
};

function load(overrides = {}) {
  return spawnSync(process.execPath, ["-e", `require(${JSON.stringify(configPath)})`], {
    env: { ...process.env, ...configEnv, ...overrides },
    encoding: "utf8",
  });
}

test("starts with injected database variables and no env file", () => {
  expect(load().status).toBe(0);
});

test("fails with a nonzero status and missing variable names, without secrets", () => {
  const result = load({ DB_HOST: "", DB_Name: "" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("DB_HOST, DB_Name");
  expect(result.stderr).not.toContain(configEnv.DB_PASS);
});
