import test from "node:test";
import assert from "node:assert/strict";
import { HELP_TOPICS, getHelp, renderCliHelp } from "./help.mjs";

const EXPECTED_TOPICS = ["overview", "session", "version", "auth", "model", "cancel", "doctor", "panel"];

test("help exports exactly the supported topics", () => {
  assert.deepEqual(Object.keys(HELP_TOPICS), EXPECTED_TOPICS);
  for (const topic of EXPECTED_TOPICS) {
    assert.equal(getHelp(topic), HELP_TOPICS[topic]);
    assert.ok(getHelp(topic).length > 20);
  }
  assert.equal(getHelp(), HELP_TOPICS.overview);
});

test("help text states the safety and continuity contracts", () => {
  assert.match(getHelp("session"), /exact confirmed conversation ID/i);
  assert.match(getHelp("version"), /1\.1\.25/);
  assert.match(getHelp("version"), /hash\/signature gate/i);
  assert.match(getHelp("auth"), /Windows Credential Manager/i);
  assert.match(getHelp("auth"), /interactive terminal/i);
  assert.match(getHelp("auth"), /CI=true/i);
  assert.match(getHelp("auth"), /Windows user's enabled proxy configuration/i);
  assert.match(getHelp("model"), /ACCEPTED_NOT_ATTESTED/);
  assert.match(getHelp("cancel"), /never replayed/i);
  assert.match(getHelp("doctor"), /credential-free/i);
  assert.match(getHelp("doctor"), /never exposes proxy values/i);
  assert.match(getHelp("doctor"), /never runs prompts, models, update, or login/i);
  assert.match(getHelp("panel"), /read-only/i);
  assert.match(getHelp("panel"), /127\.0\.0\.1/);
});

test("CLI help includes every topic and common MCP tool name", () => {
  const cli = renderCliHelp();
  for (const topic of EXPECTED_TOPICS) assert.match(cli, new RegExp(`\\[${topic}\\]`));
  for (const tool of ["agy_help", "agy_doctor", "agy_session_start", "agy_session_inspect", "agy_session_control"]) {
    assert.match(cli, new RegExp(tool));
  }
  assert.match(cli, /stream-json/);
});
