import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../src/components/ui/button";

function Fixture() {
  const [count, setCount] = useState(0);
  return (
    <div id="r2b-fixture">
      <output aria-label="click count">{count}</output>
      <Button onClick={() => setCount((n) => n + 1)}>fixture action</Button>
      <Button disabled onClick={() => setCount((n) => n + 1)}>
        fixture disabled
      </Button>
      <Button asChild variant="outline" onClick={() => setCount((n) => n + 1)}>
        <a href="#r2b-target">fixture link</a>
      </Button>
      <Button variant="ghost" size="sm">
        fixture ghost
      </Button>
      <Button variant="danger" size="sm">
        fixture danger
      </Button>
      <Button variant="plain" onClick={() => setCount((n) => n + 1)}>
        fixture plain
      </Button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setCount((n) => n + 1);
        }}
      >
        <Button>fixture submit</Button>
      </form>
    </div>
  );
}
const host = document.createElement("div");
document.body.append(host);
createRoot(host).render(<Fixture />);
