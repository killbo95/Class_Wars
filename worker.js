export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ ok: true, game: "Class Wars", multiplayer: "ready", maxPlayersPerRoom: 150 });
    }
    const match = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{3,12})\/?$/);
    if (!match) return new Response("Class Wars room endpoint. Use /room/ROOMCODE", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json({ game: "Class Wars", room: match[1], instruction: "Connect using WebSocket." }, { status: 426 });
    }
    const id = env.GAME_ROOMS.idFromName(match[1].toUpperCase());
    return env.GAME_ROOMS.get(id).fetch(request);
  }
};

const W = 900, H = 620, COLS = 30, ROWS = 20;
const MAX_PLAYERS = 150, ROUND_MS = 180000;
const COLORS = ["#c8ff54","#5bbcff","#ff5b9d","#b78bff","#ffb84d","#48e0b3","#ff7557","#f2f3ff"];
const CLASSES = {
  runner: { speed: 3.5 },
  guardian: { speed: 2.35 },
  engineer: { speed: 2.7 },
  trickster: { speed: 2.9 }
};
const EVENTS = [
  "RESOURCE RUSH! Control point bonuses are live!",
  "MAP GLITCH! The chaos has increased.",
  "SUPPLY DROP! New power-ups appeared.",
  "ALLIANCE WINDOW! Make a deal before the next fight."
];
const random = (a,b) => Math.random() * (b-a) + a;
const clamp = (n,a,b) => Math.max(a,Math.min(b,n));

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.players = new Map();
    this.tiles = Array.from({length: COLS*ROWS}, () => ({team:-1}));
    this.powerups = [];
    this.sockets = new Map();
    this.socketIds = new Map();
    this.roundTimer = setInterval(() => { if (!this.roundEnded && Date.now()-this.roundStarted >= ROUND_MS) this.sendState(); }, 1000);
    this.roundStarted = Date.now();
    this.roundEnded = false;
    this.controlOwner = -1;
    this.nextTeam = 0;
    this.lastEvent = Date.now();
    this.lastPowerup = Date.now();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    server.addEventListener("message", event => this.handleMessage(server, event.data));
    server.addEventListener("close", () => this.removeSocket(server));
    server.addEventListener("error", () => this.removeSocket(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  handleMessage(ws, message) {
    let data;
    try { data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)); }
    catch { return; }
    const attached = this.socketIds.get(ws);
    if (data.type === "join") {
      if (attached && this.players.has(attached)) return;
      if (this.players.size >= MAX_PLAYERS) {
        this.safeSend(ws, {type:"error",message:"This room is full (150 players)."});
        ws.close(1008, "Room full");
        return;
      }
      const id = crypto.randomUUID();
      const classKey = Object.hasOwn(CLASSES, data.classKey) ? data.classKey : "runner";
      const name = String(data.name || "Player").replace(/[<>]/g, "").trim().slice(0,16) || "Player";
      const p = {
        id, name, classKey, x:random(60,W-60), y:random(60,H-60),
        team:this.nextTeam++, score:0, speed:CLASSES[classKey].speed,
        lastMove:Date.now(), lastBonk:0, lastAbility:0, lastControl:0,
        shieldUntil:0, dx:1, dy:0
      };
      this.socketIds.set(ws,id);
      this.players.set(id,p);
      this.sockets.set(id,ws);
      this.sendEvent(name + " joined the chaos.");
      this.sendState();
      return;
    }
    const p = this.players.get(attached);
    if (!p || this.roundEnded) return;
    if (data.type === "move") {
      const now = Date.now();
      if (now - p.lastMove < 45) return;
      const x = Number(data.x), y = Number(data.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const dx = x-p.x, dy = y-p.y, distance = Math.hypot(dx,dy);
      const elapsed = Math.min(180, now-p.lastMove);
      const allowed = Math.min(42, Math.max(10, elapsed * 0.24));
      if (distance > 0) { p.dx=dx/distance; p.dy=dy/distance; }
      const scale = distance > allowed ? allowed/distance : 1;
      p.x = clamp(p.x + dx*scale, 8, W-8);
      p.y = clamp(p.y + dy*scale, 8, H-8);
      p.lastMove = now;
      this.claim(p);
      this.collectPowerup(p);
      this.updateControl(p,now);
      this.sendState();
    } else if (data.type === "bonk") {
      const now = Date.now();
      if (now-p.lastBonk < 900) return;
      p.lastBonk = now;
      let target = null, best = 76;
      for (const other of this.players.values()) {
        if (other.id === p.id) continue;
        const d = Math.hypot(other.x-p.x,other.y-p.y);
        if (d < best) { best=d; target=other; }
      }
      if (target) {
        if (target.shieldUntil > now) this.sendEvent(target.name + " blocked a bonk!");
        else {
          target.x=random(35,W-35); target.y=random(35,H-35);
          p.score += 5;
          this.claim(p);
          this.sendEvent("BONK! " + p.name + " launched " + target.name + ". +5 points");
        }
      } else this.sendEvent(p.name + " bonked the air. The air lost.");
      this.sendState();
    } else if (data.type === "ability") {
      const now = Date.now();
      if (now-p.lastAbility < 8000) {
        this.safeSend(ws,{type:"error",message:"Your class ability is recharging."});
        return;
      }
      p.lastAbility=now;
      if (p.classKey === "runner") {
        p.x=clamp(p.x+p.dx*130,8,W-8); p.y=clamp(p.y+p.dy*130,8,H-8);
        this.claim(p); this.sendEvent(p.name+" used Runner Dash!");
      } else if (p.classKey === "guardian") {
        p.shieldUntil=now+4000; this.sendEvent(p.name+" activated Guardian Shield!");
      } else if (p.classKey === "engineer") {
        p.score+=12; this.claim(p); this.sendEvent(p.name+" used Engineer Overcharge! +12");
      } else {
        const target=[...this.players.values()].filter(o=>o.id!==p.id)
          .sort((a,b)=>Math.hypot(a.x-p.x,a.y-p.y)-Math.hypot(b.x-p.x,b.y-p.y))[0];
        if (target) {
          const x=p.x,y=p.y; p.x=clamp(target.x+45,8,W-8); p.y=clamp(target.y+25,8,H-8);
          target.x=x; target.y=y; this.claim(p); this.sendEvent(p.name+" used Trickster Blink!");
        } else {
          p.x=clamp(p.x+random(-120,120),8,W-8); p.y=clamp(p.y+random(-90,90),8,H-8);
          this.claim(p); this.sendEvent(p.name+" blinked across the map!");
        }
      }
      this.sendState();
    }
  }

  updateControl(p,now) {
    if (Math.hypot(p.x-W/2,p.y-H/2)>75) return;
    if (this.controlOwner !== p.team) {
      this.controlOwner=p.team;
      this.sendEvent(p.name+" captured the central control point!");
    }
    if (now-p.lastControl>=2000) {
      p.lastControl=now;
      p.score+=3;
    }
  }

  claim(p) {
    const c=clamp(Math.floor(p.x/(W/COLS)),0,COLS-1);
    const r=clamp(Math.floor(p.y/(H/ROWS)),0,ROWS-1);
    const tile=this.tiles[r*COLS+c];
    if(tile.team!==p.team){tile.team=p.team;p.score++;}
  }

  collectPowerup(p) {
    for(let i=this.powerups.length-1;i>=0;i--){
      const pu=this.powerups[i];
      if(Math.hypot(p.x-pu.x,p.y-pu.y)<20){
        if(pu.kind===0){p.score+=8;this.sendEvent(p.name+" grabbed a territory boost! +8");}
        else if(pu.kind===1){p.score+=3;this.sendEvent(p.name+" grabbed a speed spark! +3");}
        else{
          const target=[...this.players.values()].filter(o=>o.id!==p.id)
            .sort((a,b)=>Math.hypot(a.x-p.x,a.y-p.y)-Math.hypot(b.x-p.x,b.y-p.y))[0];
          if(target && target.shieldUntil<Date.now()){
            target.x=random(35,W-35);target.y=random(35,H-35);p.score+=4;
            this.sendEvent(p.name+" triggered a chaos blast!");
          }
        }
        this.powerups.splice(i,1);
      }
    }
  }

  safeSend(ws,data){try{ws.send(JSON.stringify(data));}catch{}}
  sendEvent(text){for(const ws of this.sockets.values())this.safeSend(ws,{type:"event",text});}
  removeSocket(ws){
    const id=this.socketIds.get(ws);
    this.socketIds.delete(ws);
    if(!id){if(this.players.size===0&&this.roundTimer){clearInterval(this.roundTimer);this.roundTimer=null;}return;}
    const p=this.players.get(id);
    if(p)this.sendEvent(p.name+" left the room.");
    this.players.delete(id);this.sockets.delete(id);if(this.players.size===0&&this.roundTimer){clearInterval(this.roundTimer);this.roundTimer=null;}this.sendState();
  }

  sendState() {
    const now=Date.now();
    if(!this.roundEnded && now-this.roundStarted>=ROUND_MS){
      this.roundEnded=true;
      const winner=[...this.players.values()].sort((a,b)=>b.score-a.score)[0];
      this.sendEvent(winner ? "ROUND OVER! "+winner.name+" wins with "+winner.score+" points." : "ROUND OVER!");
    }
    if(!this.roundEnded && now-this.lastEvent>30000){
      this.lastEvent=now;this.sendEvent(EVENTS[Math.floor(Math.random()*EVENTS.length)]);
    }
    if(!this.roundEnded && now-this.lastPowerup>8500 && this.powerups.length<12){
      this.lastPowerup=now;this.powerups.push({x:random(30,W-30),y:random(30,H-30),kind:Math.floor(Math.random()*3)});
    }
    const players=[...this.players.values()].map(p=>({
      id:p.id,name:p.name,classKey:p.classKey,x:p.x,y:p.y,team:p.team,score:p.score,
      speed:p.speed,shieldUntil:p.shieldUntil
    }));
    const state={type:"state",players,tiles:this.tiles,powerups:this.powerups,controlOwner:this.controlOwner,
      roundStarted:this.roundStarted,roundEnded:this.roundEnded};
    for(const [id,ws] of this.sockets.entries())this.safeSend(ws,{...state,you:id});
  }
}
