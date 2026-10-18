"use client";

import { useState } from "react";

export default function LayoutCounter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" data-testid="layout-count" onClick={() => setCount((c) => c + 1)}>
      Layout count: {count}
    </button>
  );
}
