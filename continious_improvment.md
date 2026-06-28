# Continuous Improvement

## Goal
Optimize **all code** in this repo — game scripts, the WebSocket bridge, build tooling, everything is fair game.

## Loop
1. Query live game state via bridge REPL
2. Identify highest-value optimization (script logic, bridge perf, type safety, automation gaps)
3. Implement, push (auto-syncs to game), observe
4. Repeat

## Mindset
- Playing the game is a **means** to test and improve the automation
- No code is sacred — if it can be faster, cleaner, or smarter, fix it
- End state: fully autonomous Bitburner playthrough with minimal manual intervention
