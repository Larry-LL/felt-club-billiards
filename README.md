# Felt Club 8-Ball

Felt Club 8-Ball is a standalone browser-based billiards game with live room links, solo practice, and a computer opponent.

## Features

- Host a live room and let a second player join through the same server
- Play locally, over your LAN, or online once the server is deployed publicly
- Practice alone with the same aiming and physics controls
- Play against `House Bot`
- Follow 8-ball style rules with an open table, solids, stripes, and 8-ball finish logic
- Watch shot playback from server-generated physics frames so both players stay in sync

## Run Locally

```bash
git clone https://github.com/Larry-LL/felt-club-billiards.git
cd felt-club-billiards
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Online Multiplayer

Multiplayer works by keeping each room on the Node server and streaming updates to every connected player. If this server is running on a public URL, anyone with the room link can join online and play the same rack in real time.

## Controls

1. Start your drag on the cue ball.
2. Pull backward to set direction and power.
3. Release to shoot.
4. On multiplayer rooms, copy the room link and send it to the other player.

## Notes

- Room state is kept in memory, so restarting the server resets active games.
- If `package.json` or `package-lock.json` changes, run `npm install` again.
