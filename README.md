> [!WARNING]
> THIS PROJECT IS VIBECODED

# ReconMC

Minecraft server scanner with a coordinator API, scanning agents, Discord bot, and web dashboard.

# WORK IN PROGRESS

# Basic Setup

```
git clone https://github.com/aurickk/ReconMC.git
```
Clone the repo

```
cp .env.example .env
```
Setup the .env file, follow the example file to setup your variables accordingly


```
docker compose up --build
```
Build and deploy the coordinator and agent stack


```
npm run build --workspace=@reconmc/dashboard
npm run dev --workspace=@reconmc/dashboard
```

Build and run the dashboard


```
npm run build --workspace=@reconmc/discord-bot
npm run dev --workspace=@reconmc/discord-bot
```
Build and run the discord bot

You need Discord bot setup for this and im too lazy to write one for now

