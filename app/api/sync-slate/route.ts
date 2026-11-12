import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

const API_KEY = process.env.ODDS_API_KEY;

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
      `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events?apiKey=${API_KEY}`,
      { cache: "no-store" }
    );
    const events = await eventsRes.json();

    if (!Array.isArray(events) || events.length === 0) {
      return NextResponse.json({ message: "No upcoming games found", raw: events });
    }

    // Filter to games happening within the next 7 days (the current NFL week)
    const oneWeekFromNow = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const weeklyGames = events.filter(
      (e: any) => new Date(e.commence_time).getTime() <= oneWeekFromNow
    );

    const loadedSummary = [];

    for (const game of weeklyGames) {
      // 2. Fetch Anytime TD Scorer odds for each game
      const oddsRes = await fetch(
        `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/events/${game.id}/odds?apiKey=${API_KEY}&regions=us&markets=player_anytime_td&oddsFormat=american`,
        { cache: "no-store" }
      );
      const oddsData = await oddsRes.json();

      const bookmaker =
        oddsData.bookmakers?.find((b: any) => b.key === "draftkings") ||
        oddsData.bookmakers?.[0];

      const tdMarket = bookmaker?.markets?.find(
        (m: any) => m.key === "player_anytime_td"
      );

      let topScorers = [];
      if (tdMarket?.outcomes) {
        topScorers = tdMarket.outcomes
          .sort((a: any, b: any) => a.price - b.price)
          .slice(0, 10)
          .map((p: any) => ({
            name: p.description || p.name,
            americanOdds: p.price,
            decimalOdds: americanToDecimal(p.price),
          }));
      }

      const startTime = new Date(game.commence_time).toLocaleTimeString("en-US", {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
        timeZoneName: "short",
      });

      // 3. Upsert into Supabase and check for errors
      const { error: upsertError } = await supabase.from("games").upsert({
        id: game.id,
        home_team: game.home_team,
        away_team: game.away_team,
        start_time: startTime,
        top_scorers: topScorers,
      });

      if (upsertError) {
        return NextResponse.json(
          { error: "Supabase Upsert Failed", details: upsertError.message },
          { status: 500 }
        );
      }

      loadedSummary.push({
        matchup: `${game.away_team} @ ${game.home_team}`,
        startTime,
        scorersFound: topScorers.length,
        top3Preview: topScorers.slice(0, 3),
      });
    }

    return NextResponse.json({
      success: true,
      count: loadedSummary.length,
      games: loadedSummary,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
