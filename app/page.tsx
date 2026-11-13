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
  const [showPickForm, setShowPickForm] = useState(true);
  const [expandedRecordId, setExpandedRecordId] = useState<string | null>(null);
  const [expandedParlayId, setExpandedParlayId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  // 1. Fetch initial data from Supabase & sort chronologically
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

  // Calculate live leaderboards
  const scoredGuests = submissions.map((sub) => {
    let wins = 0;
    let losses = 0;
    let ties = 0;
    let cumulativeParlayOdds = 1.0;
    let tdHits = 0;

    games.forEach((game) => {
      const pick = sub.picks?.[game.id];
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

  // Color helpers for expandable pick clusters
  const getWinnerBadgeStyle = (game: Game, selectedWinner: string) => {
    if (game.status === "scheduled") {
      return "bg-slate-900 border-slate-800 text-slate-400"; // Neutral: not started yet
    }
    if (!game.winner) {
      return "bg-amber-950/50 border-amber-500/40 text-amber-300"; // Yellow: live or final tie
    }
    if (selectedWinner === game.winner) {
      return "bg-emerald-950/60 border-emerald-500/50 text-emerald-300"; // Green: leading or won
    }
    return "bg-rose-950/60 border-rose-500/50 text-rose-300"; // Red: trailing or lost
  };

  const getTdBadgeStyle = (game: Game, playerName: string) => {
    if (game.status === "scheduled") {
      return "bg-slate-900 border-slate-800 text-slate-400"; // Neutral: not started yet
    }
    if (game.td_scorers?.includes(playerName)) {
      return "bg-emerald-950/60 border-emerald-500/50 text-emerald-300"; // Green: scored TD
    }
    if (game.status === "final") {
      return "bg-rose-950/60 border-rose-500/50 text-rose-300"; // Red: final without TD
    }
    return "bg-amber-950/50 border-amber-500/40 text-amber-300"; // Yellow: in progress without TD yet
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
      <div className="max-w-7xl mx-auto space-y-8">
        {/* TOP HEADER */}
        <header className="flex flex-wrap justify-between items-center gap-4 border-b border-slate-800 pb-5">
          <div>
            <h1 className="text-3xl md:text-4xl font-black text-amber-400 tracking-tight">
              🏈 Watch Party Pool & Parlay
            </h1>
            <p className="text-slate-400 mt-1 text-sm">
              Click any player on the leaderboards to inspect their picks.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleSyncScores}
              disabled={syncing}
              className="text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-3 py-1.5 rounded-lg transition cursor-pointer"
            >
              {syncing ? "Syncing..." : "🔄 Refresh Scores"}
            </button>
            <button
              onClick={() => setShowPickForm(!showPickForm)}
              className="text-xs bg-sky-900/70 hover:bg-sky-800 text-sky-200 font-semibold px-3 py-1.5 rounded-lg border border-sky-700/60 cursor-pointer"
            >
              {showPickForm ? "Hide Pick Sheet" : "Show Pick Sheet"}
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
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {games.map((g) => (
                <div key={g.id} className="bg-slate-900 p-4 rounded-lg border border-slate-800 space-y-3">
                  <div className="text-sm font-bold text-amber-400">
                    {g.away_team} @ {g.home_team}
                  </div>

                  <div>
                    <span className="text-[11px] text-slate-400 uppercase font-bold block mb-1">
                      Set Final Winner:
                    </span>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setGameWinner(g.id, g.away_team)}
                        className={`text-xs px-2.5 py-1 rounded border transition ${
                          g.winner === g.away_team
                            ? "bg-amber-500 text-black font-bold border-amber-400"
                            : "bg-slate-800 text-white border-slate-700"
                        }`}
                      >
                        {g.away_team} Won
                      </button>
                      <button
                        onClick={() => setGameWinner(g.id, g.home_team)}
                        className={`text-xs px-2.5 py-1 rounded border transition ${
                          g.winner === g.home_team
                            ? "bg-amber-500 text-black font-bold border-amber-400"
                            : "bg-slate-800 text-white border-slate-700"
                        }`}
                      >
                        {g.home_team} Won
                      </button>
                    </div>
                  </div>

                  <div>
                    <span className="text-[11px] text-slate-400 uppercase font-bold block mb-1">
                      Tap Player When TD Scores:
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {g.top_scorers?.map((p) => {
                        const hasScored = g.td_scorers?.includes(p.name);
                        return (
                          <button
                            key={p.name}
                            onClick={() => toggleTdScorer(g, p.name)}
                            className={`text-xs px-2.5 py-1 rounded border transition ${
                              hasScored
                                ? "bg-emerald-500 text-black font-bold border-emerald-400 shadow"
                                : "bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"
                            }`}
                          >
                            {p.name} {hasScored ? "✓" : ""}
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

        {/* MAIN LAYOUT: CENTRAL LEADERBOARDS + OPTIONAL SIDEBAR PICK FORM */}
        <div className={`grid grid-cols-1 ${showPickForm ? "xl:grid-cols-12" : ""} gap-8 items-start`}>
          {/* CENTRAL LEADERBOARDS */}
          <div className={`${showPickForm ? "xl:col-span-8" : "max-w-5xl mx-auto w-full"} space-y-6`}>
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
                    {recordLeaderboard.map((guest, idx) => {
                      const isExpanded = expandedRecordId === guest.id;
                      return (
                        <div
                          key={guest.id}
                          className="bg-slate-950 rounded-lg border border-slate-800/80 overflow-hidden"
                        >
                          <button
                            type="button"
                            onClick={() => setExpandedRecordId(isExpanded ? null : guest.id)}
                            className="w-full flex justify-between items-center px-3.5 py-2.5 hover:bg-slate-900/80 transition text-left cursor-pointer"
                          >
                            <div className="flex items-center gap-3">
                              <span className="text-slate-500 font-mono text-sm">#{idx + 1}</span>
                              <span className="font-semibold text-slate-100">{guest.user_name}</span>
                              <span className="text-[10px] text-slate-500">
                                {isExpanded ? "▲" : "▼"}
                              </span>
                            </div>
                            <span className="font-mono font-bold text-sky-400 bg-sky-950/60 px-3 py-1 rounded border border-sky-800/50">
                              {guest.wins}-{guest.losses}-{guest.ties}
                            </span>
                          </button>

                          {/* EXPANDABLE PICK CLUSTER: STRAIGHT-UP PICKS */}
                          {isExpanded && (
                            <div className="px-3.5 pb-3 pt-2 border-t border-slate-800/80 bg-slate-950/60">
                              <div className="flex flex-wrap gap-1.5">
                                {games.map((game) => {
                                  const pick = guest.picks?.[game.id];
                                  if (!pick) return null;
                                  const mascot = pick.selectedWinner.split(" ").pop();
                                  return (
                                    <span
                                      key={game.id}
                                      title={`${game.away_team} @ ${game.home_team}`}
                                      className={`text-[11px] font-semibold px-2 py-1 rounded border ${getWinnerBadgeStyle(
                                        game,
                                        pick.selectedWinner
                                      )}`}
                                    >
                                      {mascot}
                                    </span>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
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
                    {parlayLeaderboard.map((guest, idx) => {
                      const isExpanded = expandedParlayId === guest.id;
                      return (
                        <div
                          key={guest.id}
                          className="bg-slate-950 rounded-lg border border-slate-800/80 overflow-hidden"
                        >
                          <button
                            type="button"
                            onClick={() => setExpandedParlayId(isExpanded ? null : guest.id)}
                            className="w-full flex justify-between items-center px-3.5 py-2.5 hover:bg-slate-900/80 transition text-left cursor-pointer"
                          >
                            <div className="flex items-center gap-3">
                              <span className="text-slate-500 font-mono text-sm">#{idx + 1}</span>
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold text-slate-100">{guest.user_name}</span>
                                  <span className="text-[10px] text-slate-500">
                                    {isExpanded ? "▲" : "▼"}
                                  </span>
                                </div>
                                <span className="text-xs text-slate-400">{guest.tdHits} TD Hits</span>
                              </div>
                            </div>
                            <span className="font-mono font-bold text-emerald-400 bg-emerald-950/60 px-3 py-1 rounded border border-emerald-800/50">
                              {guest.parlayMultiplier.toFixed(2)}x
                            </span>
                          </button>

                          {/* EXPANDABLE PICK CLUSTER: TD SCORERS */}
                          {isExpanded && (
                            <div className="px-3.5 pb-3 pt-2 border-t border-slate-800/80 bg-slate-950/60">
                              <div className="flex flex-wrap gap-1.5">
                                {games.map((game) => {
                                  const pick = guest.picks?.[game.id];
                                  if (!pick) return null;
                                  const oddsLabel =
                                    pick.selectedPlayer.americanOdds > 0
                                      ? `+${pick.selectedPlayer.americanOdds}`
                                      : pick.selectedPlayer.americanOdds;
                                  return (
                                    <span
                                      key={game.id}
                                      title={`${game.away_team} @ ${game.home_team}`}
                                      className={`text-[11px] font-semibold px-2 py-1 rounded border ${getTdBadgeStyle(
                                        game,
                                        pick.selectedPlayer.name
                                      )}`}
                                    >
                                      {pick.selectedPlayer.name} ({oddsLabel})
                                    </span>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* SIDEBAR / SECONDARY PICKS FORM */}
          {showPickForm && (
            <form
              onSubmit={handleSubmit}
              className="xl:col-span-4 bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-xl space-y-5"
            >
              <div className="border-b border-slate-800 pb-4">
                <h2 className="text-xl font-bold text-white">Enter Your Picks</h2>
                <p className="text-xs text-slate-400 mt-1">
                  Pick straight-up winner & 1 TD scorer per game.
                </p>
                <div className="mt-3">
                  <label className="block text-xs uppercase font-bold text-slate-400 mb-1">
                    Your Name
                  </label>
                  <input
                    type="text"
                    value={userName}
                    onChange={(e) => setUserName(e.target.value)}
                    placeholder="e.g. The Rat"
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-400"
                  />
                </div>
              </div>

              <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
                {games.map((game) => (
                  <div
                    key={game.id}
                    className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 space-y-3"
                  >
                    <div className="flex justify-between items-center border-b border-slate-800 pb-2">
                      <span className="text-[11px] font-mono uppercase text-amber-400">
                        {game.start_time}
                      </span>
                      <span
                        className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded ${
                          game.status === "final"
                            ? "bg-slate-800 text-slate-300"
                            : "bg-emerald-900/50 text-emerald-300"
                        }`}
                      >
                        {game.status.replace("_", " ")}
                      </span>
                    </div>

                    <div>
                      <label className="block text-[11px] uppercase font-bold text-slate-400 mb-1.5">
                        1. Pick Winner
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        {[game.away_team, game.home_team].map((team) => {
                          const isSelected = picks[game.id]?.selectedWinner === team;
                          return (
                            <button
                              key={team}
                              type="button"
                              onClick={() => handleWinnerSelect(game.id, team)}
                              className={`py-2 px-2.5 rounded-lg font-bold border text-xs transition ${
                                isSelected
                                  ? "bg-amber-500 border-amber-400 text-slate-950 shadow-md"
                                  : "bg-slate-900 border-slate-700 text-slate-200 hover:bg-slate-800"
                              }`}
                            >
                              {team.split(" ").pop()}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] uppercase font-bold text-slate-400 mb-1.5">
                        2. Pick Anytime TD Scorer
                      </label>
                      <div className="grid grid-cols-2 gap-1.5">
                        {game.top_scorers?.map((player) => {
                          const isSelected = picks[game.id]?.selectedPlayer?.name === player.name;
                          return (
                            <button
                              key={player.name}
                              type="button"
                              onClick={() => handlePlayerSelect(game.id, player)}
                              className={`p-2 rounded-lg border text-left flex justify-between items-center transition ${
                                isSelected
                                  ? "bg-emerald-600 border-emerald-400 text-white shadow-md"
                                  : "bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800"
                              }`}
                            >
                              <span className="text-[11px] font-semibold leading-tight truncate pr-1">
                                {player.name}
                              </span>
                              <span
                                className={`text-[11px] font-mono font-bold shrink-0 ${
                                  isSelected ? "text-emerald-100" : "text-emerald-400"
                                }`}
                              >
                                {player.americanOdds > 0
                                  ? `+${player.americanOdds}`
                                  : player.americanOdds}
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
                className="w-full bg-amber-400 hover:bg-amber-300 text-slate-950 font-black py-3 rounded-xl text-sm uppercase tracking-wide transition shadow-lg cursor-pointer"
              >
                Lock In Picks
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
