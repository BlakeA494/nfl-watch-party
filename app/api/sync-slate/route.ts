import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

const API_KEY = process.env.ODDS_API_KEY;

// Helper to convert American (+150 / -110) to Decimal (2.50 / 1.91)
function americanToDecimal(american: number): number {
  if (american > 0) {
    return parseFloat(((american / 100) + 1).toFixed(2));
  } else {
    return parseFloat(((100 / Math.abs(american)) + 1).toFixed(2));
  }
}

export async function GET() {
  if (!API_KEY) {
    return NextResponse.json({ error: "Missing ODDS_API_KEY" }, { status: 500 });
  }

  try {
    // 1. Fetch upcoming NFL games
    const eventsRes = await fetch(
      `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events?apiKey=${API_KEY}`
    );
    const events = await eventsRes.json();

    if (!Array.isArray(events) || events.length === 0) {
      return NextResponse.json({ message: "No upcoming games found" });
    }

    // Select upcoming games for the party (limit to first 4 or 5)
    const partyGames = events.slice(0, 4);

    for (const game of partyGames) {
      // 2. Fetch Anytime TD Scorer odds for each game
      const oddsRes = await fetch(
        `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events/${game.id}/odds?apiKey=${API_KEY}&regions=us&markets=player_anytime_td&oddsFormat=american`
      );
      const oddsData = await oddsRes.json();

      // Find the DraftKings or FanDuel bookmaker props
      const bookmaker =
        oddsData.bookmakers?.find((b: any) => b.key === "draftkings") ||
        oddsData.bookmakers?.[0];

      const tdMarket = bookmaker?.markets?.find(
        (m: any) => m.key === "player_anytime_td"
      );

      let topScorers = [];
      if (tdMarket?.outcomes) {
        // Sort players by shortest odds (most likely to score) and take the top 10
        topScorers = tdMarket.outcomes
          .sort((a: any, b: any) => a.price - b.price)
          .slice(0, 10)
          .map((p: any) => ({
            name: p.description || p.name,
            americanOdds: p.price,
            decimalOdds: americanToDecimal(p.price),
          }));
      }

      // Format game time display
      const startTime = new Date(game.commence_time).toLocaleTimeString("en-US", {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      });

      // 3. Upsert game into Supabase
      await supabase.from("games").upsert({
        id: game.id,
        home_team: game.home_team,
        away_team: game.away_team,
        start_time: startTime,
        top_scorers: topScorers,
      });
    }

    return NextResponse.json({ success: true, count: partyGames.length });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}