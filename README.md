# ASMW Trivia

A browser game where up to 4 players join a room with a 4-letter code and race to answer high school trivia in the style of the TV quiz show *As Schools Match Wits*.

## Run it

```bash
npm install
npm start          # http://localhost:3000  (set PORT to change)
npm test           # plays full games with 4 simulated players
```

## How a game works

1. One player enters a name and clicks **Create a game**. They get a room code and become the host.
2. Up to 3 more players join with the code (or the invite link, which fills it in).
3. The host picks categories and 5, 10, 15 or 20 questions, then starts.
4. Each question has 15 seconds. A right answer scores 500 points plus up to 500 more for speed. The round ends early once everyone has answered.
5. After each question everyone sees the right answer, who picked what, and the scoreboard. The final screen ranks everyone, and the host can start another game in the same room without repeating questions.

Refreshing the page puts a player back into their game. If the host leaves, the next player becomes host.

## Project layout

- `server.js` Express + Socket.IO server
- `src/game.js` rooms, timers, scoring (the server is the only one that knows the right answer until the reveal)
- `data/questions.json` question bank, 674 questions in 7 categories (Social Studies, Math & Science, Literature, Arts & Entertainment, Geography, General Knowledge, World Events). Each line is `[question, correct, wrong, wrong, wrong]`. `_categories` lists the category names in lobby order; add a category by adding a key there and a matching list.

The questions follow the categories and style of *As Schools Match Wits*. Real questions from past episodes are adapted to multiple choice; the rest are written in the same style. Research notes are kept outside the repo.
- `public/` the page players see

## Hosting

It needs a host that keeps a Node process running and allows WebSockets. Rooms live in memory, so run a single instance.

**Render (free):** `render.yaml` sets everything up. Sign in at render.com with GitHub, choose **New > Blueprint**, pick this repo and click **Apply**. The free plan sleeps after 15 minutes without visitors, so the first visit after that takes about a minute to load, and any games in progress are lost when it sleeps.
