import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  try {
    // 1. Fetch current live NFL scoreboard from ESPN's free public API
    const espnRes = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
      { cache: "no-store" }
    );
    const espnData = await espnRes.json();
    const espnEvents = espnData.events || [];

    // 2. Fetch our stored games from Supabase
    const { data: dbGames, error: dbError } = await supabase.from("games").select("*");
    if (dbError || !dbGames) {
      return NextResponse.json({ error: dbError?.message }, { status: 500 });
    }

    let updatedCount = 0;

    for (const dbGame of dbGames) {
      // Match ESPN event by team name substring (e.g. "Chiefs" in "Kansas City Chiefs")
      const matchedEvent = espnEvents.find((evt: any) => {
        const homeName = dbGame.home_team.toLowerCase();
        const awayName = dbGame.away_team.toLowerCase();
        return (
          evt.name.toLowerCase().includes(homeName.split(" ").pop()) ||
          evt.name.toLowerCase().includes(awayName.split(" ").pop())
        );
      });

      if (!matchedEvent) continue;

      const comp = matchedEvent.competitions[0];
      const isCompleted = matchedEvent.status.type.completed;
      const statusState = isCompleted
        ? "final"
        : matchedEvent.status.type.state === "in"
        ? "in_progress"
        : "scheduled";

      // Determine leading or final winner
      let winner = null;
      if (statusState === "in_progress" || isCompleted) {
        const homeComp = comp.competitors.find((c: any) => c.homeAway === "home");
        const awayComp = comp.competitors.find((c: any) => c.homeAway === "away");
        const homeScore = parseInt(homeComp?.score || "0", 10);
        const awayScore = parseInt(awayComp?.score || "0", 10);

        if (homeScore > awayScore) {
          winner = dbGame.home_team;
        } else if (awayScore > homeScore) {
          winner = dbGame.away_team;
        }
        // If tied (homeScore === awayScore), winner stays null so nobody gets credit yet
      }

      // Fetch TD scorers from ESPN scoring plays summary
      let tdScorers: string[] = [...(dbGame.td_scorers || [])];
      try {
        const summaryRes = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${matchedEvent.id}`,
          { cache: "no-store" }
        );
        const summaryData = await summaryRes.json();
        const scoringPlays = summaryData.scoringPlays || [];

        scoringPlays.forEach((play: any) => {
          const text = play.text || "";
          // Check if any tracked top scorer's last name appears in a TD play description
          dbGame.top_scorers?.forEach((player: any) => {
            const lastName = player.name.split(" ").slice(-1)[0];
            if (
              text.includes("pass") ||
              text.includes("run") ||
              text.includes("rush") ||
              text.includes("touchdown")
            ) {
              if (text.includes(lastName) && !tdScorers.includes(player.name)) {
                tdScorers.push(player.name);
              }
            }
          });
        });
      } catch (err) {
        console.error("Error fetching scoring plays:", err);
      }

      // Update Supabase
      await supabase
        .from("games")
        .update({
          status: statusState,
          winner: statusState === "scheduled" ? dbGame.winner : winner,
          td_scorers: tdScorers,
        })
        .eq("id", dbGame.id);

      updatedCount++;
    }

    return NextResponse.json({ success: true, updatedGames: updatedCount });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
} 
