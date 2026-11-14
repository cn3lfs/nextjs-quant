import { beforeEach, expect, it } from "vitest";
import { useScreenSession } from "~/lib/stores/screen-session";

beforeEach(() =>
  useScreenSession.setState(useScreenSession.getInitialState(), true),
);

it("preserves filters for the same task and resets result controls only when task identity changes", () => {
  const session = useScreenSession.getState();
  session.selectJob("first");
  session.setScreenPage(3);
  session.setExcludedPage(2);
  session.setErrorPage(1);
  session.setScreenQuery("银行");
  session.setScreenSort("score");
  session.setScreenDirection("asc");
  const selected = useScreenSession.getState();
  session.selectJob("first");
  expect(useScreenSession.getState()).toBe(selected);
  session.selectJob("second");
  expect(useScreenSession.getState()).toMatchObject({
    screenId: "second",
    screenPage: 0,
    excludedPage: 0,
    errorPage: 0,
    screenQuery: "",
    screenSort: "original",
    screenDirection: "asc",
  });
});
