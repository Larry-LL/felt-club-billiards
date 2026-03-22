# Felt Club Billiards

This is a browser-based multiplayer billiards game you can host locally, share with a friend, and play from a room link.

## What It Does

- Creates a private room with a short invite code
- Supports a solo practice table for drills
- Supports a computer-opponent mode for solo matches
- Lets a second player join from the same local network or a deployed URL
- Simulates billiards shots on the server so both players stay in sync
- Keeps score across the rack
- Allows either seated player to reset the table for a new game
- Shows a live aim line and upgraded table/ball rendering

## Run Locally

```bash
cd /Users/lawrence/Desktop/Financial_App/billiards-game
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## How To Play

1. Enter your display name and click `Practice Solo` for drills, `Play Computer` for a CPU match, or `Create Room` for multiplayer.
2. Copy the invite link or send the 5-letter room code to your friend.
3. Your friend opens the app, enters the code, and clicks `Join Room`.
4. Move your pointer to preview the aim line, then drag away from the cue ball to control shot power.
5. First player to pocket 4 colored balls wins the rack.

## Share With Friends

To play over the internet, deploy the app to a public host or run it on a machine your friend can reach and share that URL. The game state is stored in memory, so active rooms reset if the server restarts.
