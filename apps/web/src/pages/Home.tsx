import { Link } from "react-router";
import { useState, useEffect, useRef } from "react";
import * as z from "zod/v4";
import { useBlob } from "../hooks/useBlob.js";
import {
  RoundSummarySchema,
  SeasonSchema,
  SeasonSummarySchema,
} from "@bccweb/schemas";
import type { RoundSummary, Season, SeasonSummary } from "@bccweb/types";
import { LoadingSpinner, ErrorMessage } from "../components/LoadingSpinner.js";
import { StatusBadge } from "../components/StatusBadge.js";

const TODAY = new Date().toISOString().slice(0, 10);

const HERO_IMAGES = [
  "/images/Hero_1.jpg",
  "/images/Hero_2.jpg",
  "/images/Hero_3.jpg",
];

function HeroCarousel() {
  const [current, setCurrent] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCurrent((c) => (c + 1) % HERO_IMAGES.length);
    }, 6000);
  };

  useEffect(() => {
    startTimer();
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const go = (idx: number) => {
    setCurrent(idx);
    startTimer();
  };

  const prev = () => go((current - 1 + HERO_IMAGES.length) % HERO_IMAGES.length);
  const next = () => go((current + 1) % HERO_IMAGES.length);

  return (
    <div className="bcc-hero">
      <div
        className="bcc-hero__slides"
        style={{ transform: `translateX(-${current * 100}%)` }}
      >
        {HERO_IMAGES.map((src, i) => (
          <div className="bcc-hero__slide" key={i}>
            <img src={src} alt={`BCC paragliding scene ${i + 1}`} />
          </div>
        ))}
      </div>

      <button className="bcc-hero__prev" onClick={prev} aria-label="Previous">&#8249;</button>
      <button className="bcc-hero__next" onClick={next} aria-label="Next">&#8250;</button>

      <div className="bcc-hero__controls">
        {HERO_IMAGES.map((_, i) => (
          <button
            key={i}
            className={`bcc-hero__dot${i === current ? " bcc-hero__dot--active" : ""}`}
            onClick={() => go(i)}
            aria-label={`Go to slide ${i + 1}`}
          />
        ))}
      </div>
    </div>
  );
}

function HomeLeagueTable({ year }: { year: number }) {
  const { data: season, loading, error, notFound } = useBlob<Season>(`seasons/${year}.json`, SeasonSchema);

  if (loading) return <LoadingSpinner />;
  if (notFound) return null;
  if (error) return <ErrorMessage error={error} />;
  if (!season?.leagueTable || season.leagueTable.length === 0) return null;

  const top = season.leagueTable.slice(0, 8);

  return (
    <section style={{ marginBottom: "2.5rem" }}>
      <h2 className="bcc-section-title">
        {year} League — Top {top.length}
        <Link to={`/results/${year}`}>Full table &rarr;</Link>
      </h2>
      <table className="bcc-table bcc-table--striped">
        <thead>
          <tr>
            <th style={{ textAlign: "right", width: "2.5rem" }}>#</th>
            <th>Team</th>
            <th>Club</th>
            <th style={{ textAlign: "right" }}>Score</th>
          </tr>
        </thead>
        <tbody>
          {top.map((entry) => (
            <tr key={entry.teamName}>
              <td style={{ textAlign: "right", color: "#999", fontSize: "0.85rem" }}>
                {entry.rank}
              </td>
              <td className={entry.rank <= 3 ? "bcc-table__rank--top" : ""}>
                {entry.teamName}
              </td>
              <td style={{ color: "#666" }}>{entry.clubName}</td>
              <td style={{ textAlign: "right", fontWeight: 600 }}>
                {entry.totalScore}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function HomeRoundsList({ rounds }: { rounds: RoundSummary[] }) {
  const upcoming = rounds
    .filter((r) => r.date >= TODAY && r.status !== "Cancelled" && r.status !== "Complete")
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 3);

  const recent = rounds
    .filter((r) => r.date < TODAY || r.status === "Complete")
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 3);

  const formatDate = (d: string) =>
    new Date(d + "T00:00:00").toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });

  return (
    <>
      {upcoming.length > 0 && (
        <section style={{ marginBottom: "2.5rem" }}>
          <h2 className="bcc-section-title">
            Upcoming Rounds
            <Link to="/rounds">All rounds &rarr;</Link>
          </h2>
          <div>
            {upcoming.map((r) => (
              <Link key={r.id} to={`/rounds/${r.id}`} className="bcc-round-card">
                <span>
                  <span className="bcc-round-card__site">{r.siteName}</span>
                  <span className="bcc-round-card__date">{formatDate(r.date)}</span>
                </span>
                <StatusBadge status={r.status} />
              </Link>
            ))}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section style={{ marginBottom: "2.5rem" }}>
          <h2 className="bcc-section-title">Recent Rounds</h2>
          <div>
            {recent.map((r) => (
              <Link key={r.id} to={`/rounds/${r.id}`} className="bcc-round-card">
                <span>
                  <span className="bcc-round-card__site">{r.siteName}</span>
                  <span className="bcc-round-card__date">{formatDate(r.date)}</span>
                </span>
                <StatusBadge status={r.status} />
              </Link>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

export default function Home() {
  const { data: rounds, loading: roundsLoading, error: roundsError } = useBlob<RoundSummary[]>("rounds.json", z.array(RoundSummarySchema));
  const { data: seasons } = useBlob<SeasonSummary[]>("seasons.json", z.array(SeasonSummarySchema));

  const activeYear = seasons?.find((s) => s.active)?.year ?? seasons?.[seasons.length - 1]?.year;

  return (
    <>
      <HeroCarousel />

      <div className="bcc-page">
        {/* Intro text */}
        <section className="bcc-intro">
          <p>
            The <strong>Advance British Club Challenge (BCC)</strong> is a BHPA Paragliding
            Competitions Panel endorsed event, open to paragliding Flying Members of the BHPA.
          </p>
          <p>
            Designed as a friendly, recreational club-level competition, the focus is firmly on
            safety, enjoyment and mentored team flying to aid pilot development.
          </p>
          <div className="bcc-intro__actions">
            <Link to="/rounds" className="bcc-btn bcc-btn--primary">View Rounds</Link>
            {activeYear && (
              <Link to={`/results/${activeYear}`} className="bcc-btn bcc-btn--outline">
                {activeYear} League Table
              </Link>
            )}
            <Link to="/pilots" className="bcc-btn bcc-btn--ghost">Pilots</Link>
          </div>
        </section>

        {/* League table for active season */}
        {activeYear && <HomeLeagueTable year={activeYear} />}

        {/* Rounds */}
        {roundsLoading && <LoadingSpinner />}
        {roundsError && <ErrorMessage error={roundsError} />}
        {rounds && <HomeRoundsList rounds={rounds} />}
      </div>
    </>
  );
}
