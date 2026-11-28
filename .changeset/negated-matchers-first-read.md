---
"@e2e-dev/core": minor
"e2e": minor
---

**Breaking:** A negated matcher now passes on the first read that satisfies the negation, as in Playwright. It used to pass only after the negation had held for 1 second. This covers `.not` on every locator matcher (`expect(locator).not.toBeVisible()` and the rest), on `expect(browser)` (`not.toHaveURL`, `not.toHaveTitle`, `not.toHaveClass`), and on `toHaveScreenshot`, and `pollCondition` with `negated: true` in a custom engine.

A passing negated assertion is about 1 second faster. An assertion that relied on the hold, such as `.not.toBeHidden()` to check that a spinner stays up, or `.not.toBeVisible()` right after an action whose effect has not started yet, now passes at once: assert the state that follows instead, for example the content that replaces the spinner. A negated matcher still fails when no read satisfies the negation before the timeout.

A read whose node another lookup superseded no longer counts as an absent node: `toBeHidden()`, `.not.toBeVisible()`, `.not.toBeAttached()`, and `waitFor({ state: 'hidden' | 'detached' })` read again instead of passing on it.
