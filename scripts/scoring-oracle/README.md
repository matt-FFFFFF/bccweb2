# Legacy scoring oracle generator

This standalone `net10.0` console app generates the authoritative scoring fixtures in
`packages/scoring/src/__tests__/fixtures/legacy-rounds/` plus the validator manifest at
`packages/scoring/src/__tests__/fixtures/legacy-score-manifest.json`.

## Legacy source copied

Legacy repository: `/Volumes/code/BCCWEB`

Legacy commit: `0ae338f80aae3a0242c16acea4f10cb6f87912a0`

The arithmetic methods in `LegacyScoring.cs` copy these legacy methods verbatim, with
minimal model/database shims so they can run without ASP.NET MVC, EF, or SQL Server:

- `BCCWeb/Controllers/BaseController.cs:1619-1680` — `GetPilotScore`,
  `GetWingfactor`, `GetPilotFactor`.
- `BCCWeb/Controllers/BaseController.cs:2254-2309` — clubs-attending and
  min-distance factor logic.
- `BCCWeb/Controllers/BaseController.cs:2311-2468` — `GetPilotPoints`,
  `GetWorkingTeamScore`, `GetMaxTeamScore`, `GetTeamScores`, `ScoreRound`
  (`taskMaxPoints = 1000` at line 2461).
- `BCCWeb/Controllers/ResultsController.cs:184-254` — season league behavior:
  top-six `Take(6)`, `(int)Sum`, and ordinal ranks.

## Regeneration

Run from the repo root:

```sh
dotnet run --project scripts/scoring-oracle/ScoringOracle.csproj
```

The generator reads `scripts/scoring-oracle/scenarios.json` and emits complete fixture JSON.
Scenario inputs, expected intermediate values, final scores, and the manifest all come from
one generated run; no expected number is hand-transcribed.

The CLR behavior used by the legacy code was smoke-verified before this oracle was written:
`44.45f * 0.8f = 35.56`, `Math.Round(2.5, 0) = 2`, `Math.Round(3.5, 0) = 4`, and
`(int)3.9 = 3`. The fixture outputs therefore carry real CLR float32 and banker's
`Math.Round(ToEven)` semantics from the copied C#.
