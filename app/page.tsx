"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

interface PlayerOdd {
  name: string;
  americanOdds: number;
  decimalOdds: number;
}

interface Game {
  id: string;
  home_team: string;
  away_team: string;
  start_time: string;
  status: "scheduled" | "in_progress" | "final";
  winner?: string;
  td_scorers: string[];
  top_scorers: PlayerOdd[];
}

interface UserPick {
  selectedWinner: string;
  selectedPlayer: PlayerOdd;
}

interface GuestSubmission {
  id: string;
  user_name: string;
  picks: Record<string, UserPick>;
}

function parseKickoffOrder(startTime: string): number {
  const dayWeights: Record<string, number> = {
    thu: 1,
    fri: 2,
    sat: 3,
    sun: 4,
    mon: 5,
  };

  const lower = startTime.toLowerCase();
  const dayKey = Object.keys(dayWeights).find((d) => lower.startsWith(d)) || "sun";
  const dayScore = dayWeights[dayKey] * 10000;

  // Extract hour, minute, and AM/PM (e.g., "1:00 PM" or "8:15 PM")
  const match = lower.match(/(\d{1,2}):(\d{2})\s*(am|pm)/);
  if (!match) return dayScore;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const meridiem = match[3];

  if (meridiem === "pm" && hours !== 12) hours += 12;
  if (meridiem === "am" && hours === 12) hours = 0;

  return dayScore + hours * 100 + minutes;
}

export default function WatchPartyApp() {
  const [games, setGames] = useState<Game[]>([]);
  const [submissions, setSubmissions] = useState<GuestSubmission[]>([]);
  const [userName, setUserName] = useState("");
  const [picks, setPicks] = useState<Record<string, Partial<UserPick>>>({});
  const [showAdmin, setShowAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  // 1. Fetch initial data from Supabase (filtered to Sunday games only)
  const fetchData = async () => {
    const { data: gamesData, error: gamesErr } = await supabase.from("games").select("*");
    const { data: subsData, error: subsErr } = await supabase.from("pool_submissions").select("*");

    if (gamesErr) console.error("Error fetching games:", gamesErr);
    if (subsErr) console.error("Error fetching submissions:", subsErr);

   if (gamesData) {
      const sortedGames = gamesData
        .filter((g: Game) => {
          const day = g.start_time.toLowerCase();
          return day.startsWith("thu") || day.startsWith("sun");
        })
        .sort((a: Game, b: Game) => parseKickoffOrder(a.start_time) - parseKickoffOrder(b.start_time));

      setGames(sortedGames);
    };
    }
    if (subsData) setSubmissions(subsData);
    setLoading(false);
  };

 useEffect(() => {
    fetchData();

    // 2. Real-time updates subscription across all devices
    const channel = supabase
      .channel("watch-party-sync")
      .on("postgres_changes", { event: "*", schema: "public", table: "games" }, () => fetchData())
      .on("postgres_changes", { event: "*", schema: "public", table: "pool_submissions" }, () => fetchData())
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // 3. Auto-sync live scores from ESPN every 60 seconds while games are active
  useEffect(() => {
    const hasActiveOrUpcomingGames = games.some(
      (g) => g.status === "in_progress" || g.status === "scheduled"
    );

    if (!hasActiveOrUpcomingGames) return;

    const interval = setInterval(async () => {
      try {
        await fetch("/api/sync-scores");
        // Supabase Realtime will automatically trigger fetchData() across all connected devices
      } catch (err) {
        console.error("Auto-sync error:", err);
      }
    }, 60000);

    return () => clearInterval(interval);
  }, [games]);

  const handleWinnerSelect = (gameId: string, team: string) => {
    setPicks((prev) => ({
      ...prev,
      [gameId]: { ...prev[gameId], selectedWinner: team },
    }));
  };

  const handlePlayerSelect = (gameId: string, player: PlayerOdd) => {
    setPicks((prev) => ({
      ...prev,
      [gameId]: { ...prev[gameId], selectedPlayer: player },
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userName.trim()) return alert("Please enter your name!");

    for (const game of games) {
      if (!picks[game.id]?.selectedWinner || !picks[game.id]?.selectedPlayer) {
        return alert(`Please pick both a winner and TD scorer for ${game.away_team} vs ${game.home_team}!`);
      }
    }

    const { error } = await supabase.from("pool_submissions").insert({
      user_name: userName.trim(),
      picks,
    });

    if (error) {
      alert("Error submitting picks: " + error.message);
    } else {
      setUserName("");
      setPicks({});
      alert("Picks locked in successfully!");
    }
  };

  // Host Controls: live score updating
  const toggleTdScorer = async (game: Game, playerName: string) => {
    const currentScorers = game.td_scorers || [];
    const updated = currentScorers.includes(playerName)
      ? currentScorers.filter((n) => n !== playerName)
      : [...currentScorers, playerName];

    await supabase.from("games").update({ td_scorers: updated }).eq("id", game.id);
  };

  const setGameWinner = async (gameId: string, winner: string) => {
    await supabase.from("games").update({ winner, status: "final" }).eq("id", gameId);
  };

  // Calculate live leaderboards
  const scoredGuests = submissions.map((sub) => {
    let wins = 0;
    let losses = 0;
    let ties = 0;
    let cumulativeParlayOdds = 1.0;
    let tdHits = 0;

    games.forEach((game) => {
      const pick = sub.picks[game.id];
      if (!pick) return;

      // 1. Straight-up W-L-T calculation (live projected + final)
      if (game.status === "in_progress" || game.status === "final") {
        if (!game.winner) {
          ties++;
        } else if (pick.selectedWinner === game.winner) {
          wins++;
        } else {
          losses++;
        }
      }

      // 2. TD Scorer parlay calculation
      if (game.td_scorers?.includes(pick.selectedPlayer.name)) {
        tdHits++;
        cumulativeParlayOdds *= pick.selectedPlayer.decimalOdds;
      }
    });

    return {
      ...sub,
      wins,
      losses,
      ties,
      tdHits,
      parlayMultiplier: tdHits > 0 ? cumulativeParlayOdds : 0,
    };
  });

  const recordLeaderboard = [...scoredGuests].sort(
    (a, b) => b.wins + b.ties * 0.5 - (a.wins + a.ties * 0.5)
  );
  const parlayLeaderboard = [...scoredGuests].sort(
    (a, b) => b.parlayMultiplier - a.parlayMultiplier
  );

  const handleSyncScores = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/sync-scores");
      const data = await res.json();
      if (data.success) {
        alert("Scores and touchdowns synced!");
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center font-mono">
        Connecting to party pool...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="flex justify-between items-center border-b border-slate-800 pb-5">
          <div>
            <h1 className="text-3xl md:text-4xl font-black text-amber-400 tracking-tight">
              🏈 Watch Party Pool & Parlay
            </h1>
            <p className="text-slate-400 mt-1 text-sm">
              Live odds & real-time leaderboard across all devices.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleSyncScores}
              disabled={syncing}
              className="text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-3 py-1.5 rounded-lg transition cursor-pointer"
            >
              {syncing ? "Syncing..." : "🔄 Refresh Scores"}
            </button>
            <button
              onClick={() => setShowAdmin(!showAdmin)}
              className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-400 px-3 py-1.5 rounded-lg border border-slate-700 cursor-pointer"
            >
              {showAdmin ? "Hide Host Controls" : "Host Controls"}
            </button>
          </div>
        </header>

        {/* HOST LIVE SCORING PANEL */}
        {showAdmin && (
          <div className="bg-amber-950/40 border border-amber-600/40 rounded-xl p-5 space-y-4">
            <h2 className="text-lg font-bold text-amber-300">Host Controls (Toggle Live Hits & Winners)</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {games.map((g) => (
                <div key={g.id} className="bg-slate-900 p-4 rounded-lg border border-slate-800 space-y-3">
                  <div className="text-sm font-bold text-amber-400">{g.away_team} @ {g.home_team}</div>
                  
                  <div>
                    <span className="text-[11px] text-slate-400 uppercase font-bold block mb-1">Set Final Winner:</span>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setGameWinner(g.id, g.away_team)}
                        className={`text-xs px-2.5 py-1 rounded border transition ${
                          g.winner === g.away_team ? 'bg-amber-500 text-black font-bold border-amber-400' : 'bg-slate-800 text-white border-slate-700'
                        }`}
                      >
                        {g.away_team} Won
                      </button>
                      <button
                        onClick={() => setGameWinner(g.id, g.home_team)}
                        className={`text-xs px-2.5 py-1 rounded border transition ${
                          g.winner === g.home_team ? 'bg-amber-500 text-black font-bold border-amber-400' : 'bg-slate-800 text-white border-slate-700'
                        }`}
                      >
                        {g.home_team} Won
                      </button>
                    </div>
                  </div>

                  <div>
                    <span className="text-[11px] text-slate-400 uppercase font-bold block mb-1">Tap Player When TD Scores:</span>
                    <div className="flex flex-wrap gap-1.5">
                      {g.top_scorers?.map((p) => {
                        const hasScored = g.td_scorers?.includes(p.name);
                        return (
                          <button
                            key={p.name}
                            onClick={() => toggleTdScorer(g, p.name)}
                            className={`text-xs px-2.5 py-1 rounded border transition ${
                              hasScored 
                                ? 'bg-emerald-500 text-black font-bold border-emerald-400 shadow' 
                                : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
                            }`}
                          >
                            {p.name} {hasScored ? '✓' : ''}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Dual Leaderboards */}
        <div className="grid md:grid-cols-2 gap-6">
          {/* Straight Up Records */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-sky-400">🏆 Straight Up Records</h2>
              <span className="text-xs bg-sky-950 text-sky-300 px-2.5 py-1 rounded border border-sky-800">
                W-L-T
              </span>
            </div>
            {recordLeaderboard.length === 0 ? (
              <p className="text-slate-500 text-sm">No submissions yet.</p>
            ) : (
              <div className="space-y-2.5">
                {recordLeaderboard.map((guest, idx) => (
                  <div
                    key={guest.id}
                    className="flex justify-between items-center bg-slate-950 px-3.5 py-2.5 rounded-lg border border-slate-800/80"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-slate-500 font-mono text-sm">#{idx + 1}</span>
                      <span className="font-semibold text-slate-100">{guest.guest_name}</span>
                    </div>
                    {/* 👇 STRAIGHT-UP BADGE */}
                    <span className="font-mono font-bold text-sky-400 bg-sky-950/60 px-3 py-1 rounded border border-sky-800/50">
                      {guest.wins}-{guest.losses}-{guest.ties}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Combined TD Parlay Odds */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-emerald-400">🔥 Combined TD Parlay Odds</h2>
              <span className="text-xs bg-emerald-950 text-emerald-300 px-2.5 py-1 rounded border border-emerald-800">
                Hit Multipliers
              </span>
            </div>
            {parlayLeaderboard.length === 0 ? (
              <p className="text-slate-500 text-sm">No submissions yet.</p>
            ) : (
              <div className="space-y-2.5">
                {parlayLeaderboard.map((guest, idx) => (
                  <div
                    key={guest.id}
                    className="flex justify-between items-center bg-slate-950 px-3.5 py-2.5 rounded-lg border border-slate-800/80"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-slate-500 font-mono text-sm">#{idx + 1}</span>
                      <div>
                        <span className="font-semibold text-slate-100 block">{guest.guest_name}</span>
                        <span className="text-xs text-slate-400">{guest.tdHits} TD Hits</span>
                      </div>
                    </div>
                    {/* 👇 PARLAY BADGE */}
                    <span className="font-mono font-bold text-emerald-400 bg-emerald-950/60 px-3 py-1 rounded border border-emerald-800/50">
                      {guest.parlayMultiplier.toFixed(2)}x
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* PICKS FORM */}
        <form onSubmit={handleSubmit} className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl space-y-6">
          <div className="border-b border-slate-800 pb-4">
            <h2 className="text-2xl font-bold text-white">Enter Your Picks</h2>
            <p className="text-xs text-slate-400 mt-1">Pick straight-up winner & 1 TD scorer for every matchup.</p>
            <div className="mt-4 max-w-xs">
              <label className="block text-xs uppercase font-bold text-slate-400 mb-1">Your Name</label>
              <input
                type="text"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="e.g. The Rat"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
            </div>
          </div>

          <div className="space-y-6">
            {games.map((game) => (
              <div key={game.id} className="bg-slate-950 border border-slate-800/80 rounded-xl p-5 space-y-4">
                <div className="flex justify-between items-center border-b border-slate-800 pb-2">
                  <span className="text-xs font-mono uppercase text-amber-400">{game.start_time}</span>
                  <span className={`text-xs uppercase font-bold px-2 py-0.5 rounded ${
                    game.status === 'final' ? 'bg-slate-800 text-slate-300' : 'bg-emerald-900/50 text-emerald-300 animate-pulse'
                  }`}>
                    {game.status.replace('_', ' ')}
                  </span>
                </div>

                <div>
                  <label className="block text-xs uppercase font-bold text-slate-400 mb-2">1. Pick Winner</label>
                  <div className="grid grid-cols-2 gap-3">
                    {[game.away_team, game.home_team].map((team) => {
                      const isSelected = picks[game.id]?.selectedWinner === team;
                      return (
                        <button
                          key={team}
                          type="button"
                          onClick={() => handleWinnerSelect(game.id, team)}
                          className={`py-3 px-4 rounded-lg font-bold border text-sm transition ${
                            isSelected
                              ? 'bg-amber-500 border-amber-400 text-slate-950 shadow-md'
                              : 'bg-slate-900 border-slate-700 text-slate-200 hover:bg-slate-800'
                          }`}
                        >
                          {team}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="block text-xs uppercase font-bold text-slate-400 mb-2">2. Pick Anytime TD Scorer</label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
                    {game.top_scorers?.map((player) => {
                      const isSelected = picks[game.id]?.selectedPlayer?.name === player.name;
                      return (
                        <button
                          key={player.name}
                          type="button"
                          onClick={() => handlePlayerSelect(game.id, player)}
                          className={`p-2.5 rounded-lg border text-left flex flex-col justify-between transition ${
                            isSelected
                              ? 'bg-emerald-600 border-emerald-400 text-white shadow-md'
                              : 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
                          }`}
                        >
                          <span className="text-xs font-semibold leading-tight line-clamp-1">{player.name}</span>
                          <span className={`text-xs font-mono font-bold mt-1 ${isSelected ? 'text-emerald-100' : 'text-emerald-400'}`}>
                            {player.americanOdds > 0 ? `+${player.americanOdds}` : player.americanOdds}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <button
            type="submit"
            className="w-full bg-amber-400 hover:bg-amber-300 text-slate-950 font-black py-4 rounded-xl text-lg uppercase tracking-wide transition shadow-lg cursor-pointer"
          >
            Lock In Picks
          </button>
        </form>
      </div>
    </div>
  );
}
