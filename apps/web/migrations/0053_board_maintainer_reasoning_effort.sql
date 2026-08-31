-- Persist the maintainer's thinking-effort override. The runner
-- (LocalMaintainerRuntime) reads board_maintainers.reasoning_effort and passes
-- it to provider.execute({ reasoningEffort }) — matching AgentNewPage.
ALTER TABLE board_maintainers ADD COLUMN reasoning_effort TEXT;
