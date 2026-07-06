using System.Text.Json;
using System.Text.Json.Serialization;
using ScoringOracle;

JsonSerializerOptions jsonOptions = new()
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    WriteIndented = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
};

string root = FindRepoRoot(AppContext.BaseDirectory);
string scenarioPath = Path.Combine(root, "scripts", "scoring-oracle", "scenarios.json");
string fixturesDir = Path.Combine(root, "packages", "scoring", "src", "__tests__", "fixtures", "legacy-rounds");
string manifestPath = Path.Combine(root, "packages", "scoring", "src", "__tests__", "fixtures", "legacy-score-manifest.json");

ScenarioSet scenarioSet = JsonSerializer.Deserialize<ScenarioSet>(File.ReadAllText(scenarioPath), jsonOptions)
    ?? throw new InvalidOperationException("Unable to read scoring oracle scenarios.");

Directory.CreateDirectory(fixturesDir);
foreach (string file in Directory.GetFiles(fixturesDir, "*.json"))
{
    File.Delete(file);
}

Dictionary<string, Dictionary<string, ManifestTeam>> manifest = [];
List<string> headlines = [];

foreach (ScenarioDefinition scenario in scenarioSet.Scenarios)
{
    FixturePayload payload = BuildFixture(scenarioSet, scenario, manifest);
    string fixturePath = Path.Combine(fixturesDir, $"{scenario.Id}.json");
    File.WriteAllText(fixturePath, JsonSerializer.Serialize(payload, jsonOptions) + Environment.NewLine);

    TeamExpected headlineTeam = payload.Expected.Teams.OrderByDescending(team => team.Score).First();
    headlines.Add($"{scenario.Id}: maxPointsForRound={payload.Expected.Round.MaxPointsForRound}, {headlineTeam.TeamId}.score={headlineTeam.Score}");
}

File.WriteAllText(manifestPath, JsonSerializer.Serialize(manifest, jsonOptions) + Environment.NewLine);
Console.WriteLine($"Generated {scenarioSet.Scenarios.Count} fixtures.");
foreach (string headline in headlines)
{
    Console.WriteLine(headline);
}

static FixturePayload BuildFixture(
    ScenarioSet scenarioSet,
    ScenarioDefinition scenario,
    Dictionary<string, Dictionary<string, ManifestTeam>> manifest)
{
    LegacyConfig legacyConfig = new();
    ScenarioBuildContext scenarioContext = new();
    List<BuiltRound> builtRounds = scenario.Rounds.Select((round, index) => BuildRound(round, index, scenarioContext)).ToList();
    List<RoundDerivation> derivations = [];

    foreach (BuiltRound builtRound in builtRounds)
    {
        LegacyScoring scoring = new(legacyConfig, builtRound.Db);
        scoring.ScoreRound(builtRound.Round);
        RoundDerivation derivation = CaptureDerivation(scoring, builtRound);
        AssertSelfConsistent(builtRound.Round.FixtureId, derivation);
        derivations.Add(derivation);
        AddManifestRound(manifest, builtRound.Round, derivation);
    }

    List<LeagueExpected> league = new LegacyLeague().Compute(builtRounds.Select(round => round.Round).ToList());
    BuiltRound primaryRound = builtRounds[0];
    RoundDerivation primaryDerivation = derivations[0];

    return new FixturePayload(
        scenario.Id,
        scenario.Label,
        scenario.Notes,
        $"net10-verbatim-copy-of-BaseController.cs@{scenarioSet.LegacyHash}",
        null,
        "Algorithm-derived oracle fixture: no live legacy database is available in this environment, so persisted DB output legacy IDs are N/A.",
        scenarioSet.CapturedAt,
        new FixtureInput(
            ToRoundJson(primaryRound.Round, primaryRound.SlotIdsByLegacyPilotId),
            ConfigJson(),
            builtRounds.Count > 1
                ? builtRounds.Select(round => ToRoundJson(round.Round, round.SlotIdsByLegacyPilotId)).ToList()
                : null),
        new FixtureExpected(primaryDerivation, primaryDerivation.Pilots, primaryDerivation.Teams, league));
}

static BuiltRound BuildRound(RoundDefinition definition, int roundIndex, ScenarioBuildContext scenarioContext)
{
    LegacyDb db = new();
    int legacyRoundId = 10_000 + (roundIndex * 1_000) + StableInt(definition.Id) % 900;
    Round round = new()
    {
        ID = legacyRoundId,
        FixtureId = definition.Id,
        Date = DateOnly.Parse(definition.Date),
        MinimumScore = definition.MinimumScore,
    };
    Dictionary<string, Club> clubs = [];
    Dictionary<int, SlotIds> slotIds = [];
    int pilotOffset = 1;
    int flightOffset = 1;

    foreach (TeamDefinition teamDefinition in definition.Teams)
    {
        if (!clubs.TryGetValue(teamDefinition.ClubId, out Club? club))
        {
            club = new Club { ID = StableInt(teamDefinition.ClubId), Name = teamDefinition.ClubName };
            clubs.Add(teamDefinition.ClubId, club);
        }

        Team team = new()
        {
            ID = scenarioContext.GetTeamId(teamDefinition),
            TeamName = teamDefinition.TeamName,
            Club = club,
        };
        RoundTeam roundTeam = new() { ID = team.ID, Round = round, Team = team };
        round.RoundTeams.Add(roundTeam);

        foreach (PilotDefinition pilotDefinition in teamDefinition.Pilots)
        {
            int legacyPilotId = (legacyRoundId * 1_000) + pilotOffset;
            RoundTeamPilot roundTeamPilot = new()
            {
                ID = legacyPilotId,
                Pilot = new Pilot
                {
                    ID = legacyPilotId,
                    Pilot_Rating = new PilotRating { Description = pilotDefinition.PilotRating },
                },
                WingClass = pilotDefinition.WingClass,
            };
            RoundTeamPlace place = new()
            {
                PlaceInTeam = pilotDefinition.PlaceInTeam,
                IsScoring = pilotDefinition.IsScoring,
                Status = pilotDefinition.Status,
                NoScore = pilotDefinition.NoScore,
                RoundTeam = roundTeam,
                RoundTeamPilot = roundTeamPilot,
            };
            roundTeam.RoundTeamPlaces.Add(place);

            string? flightId = null;
            if (pilotDefinition.Distance is double distance)
            {
                int legacyFlightId = (legacyRoundId * 10_000) + flightOffset;
                flightId = OracleIds.Flight(legacyFlightId);
                db.Flights.Add(new Flight
                {
                    ID = legacyFlightId,
                    RoundID = round.ID,
                    Round = round,
                    RoundTeamPilot = roundTeamPilot,
                    roundTeamPlace = place,
                    Distance = distance,
                });
                flightOffset++;
            }

            slotIds.Add(legacyPilotId, new SlotIds(
                OracleIds.Team(team.ID),
                pilotDefinition.PlaceInTeam,
                OracleIds.Pilot(legacyPilotId),
                flightId,
                pilotDefinition));
            pilotOffset++;
        }
    }

    return new BuiltRound(round, db, slotIds);
}

static RoundDerivation CaptureDerivation(LegacyScoring scoring, BuiltRound builtRound)
{
    Round round = builtRound.Round;
    int taskMaxPoints = 1000;
    float clubsAttendingFactor = scoring.GetClubsAttendingFactor(round);
    float minDistanceFactor = scoring.GetMinDistanceFactor(round);
    float maxPointsForRound = taskMaxPoints * clubsAttendingFactor * minDistanceFactor;
    float maxPilotScoreInRound = builtRound.Db.Flights.Count == 0
        ? 0
        : builtRound.Db.Flights.Select(scoring.GetPilotScore).OrderByDescending(score => score).First();

    List<TeamExpected> teams = round.RoundTeams.Select(roundTeam => new TeamExpected(
        OracleIds.Team(roundTeam.Team.ID),
        scoring.GetWorkingTeamScore(roundTeam),
        roundTeam.TeamScore)).ToList();
    int maxTeamScore = teams.Count == 0 ? 0 : teams.Max(team => team.WorkingTeamScore);

    List<PilotExpected> pilots = [];
    foreach (RoundTeam roundTeam in round.RoundTeams)
    {
        foreach (RoundTeamPlace place in roundTeam.RoundTeamPlaces)
        {
            SlotIds ids = builtRound.SlotIdsByLegacyPilotId[place.RoundTeamPilot.ID];
            Flight? flight = builtRound.Db.Flights.FirstOrDefault(item => item.RoundTeamPilot.ID == place.RoundTeamPilot.ID);
            pilots.Add(new PilotExpected(
                ids.TeamId,
                ids.PlaceInTeam,
                ids.PilotId,
                flight is null ? 0 : scoring.GetPilotScore(flight),
                place.RoundTeamPilot.PilotPoints));
        }
    }

    return new RoundDerivation(
        taskMaxPoints,
        round.RoundTeams.Select(roundTeam => roundTeam.Team.Club.ID).Distinct().Count(),
        clubsAttendingFactor,
        builtRound.Db.Flights.Count(flight => flight.Distance >= round.MinimumScore),
        minDistanceFactor,
        maxPointsForRound,
        maxPilotScoreInRound,
        maxTeamScore,
        pilots,
        teams);
}

static void AddManifestRound(Dictionary<string, Dictionary<string, ManifestTeam>> manifest, Round round, RoundDerivation derivation)
{
    Dictionary<string, ManifestTeam> roundNode = [];
    foreach (TeamExpected team in derivation.Teams)
    {
        Dictionary<string, float> pilots = [];
        foreach (PilotExpected pilot in derivation.Pilots.Where(pilot => pilot.TeamId == team.TeamId))
        {
            pilots.Add(pilot.PlaceInTeam.ToString(), pilot.PilotPoints);
        }

        roundNode.Add(team.TeamId, new ManifestTeam(team.Score, team.WorkingTeamScore, pilots));
    }

    manifest.Add(round.FixtureId, roundNode);
}

static object ToRoundJson(Round round, Dictionary<int, SlotIds> slotIdsByLegacyPilotId)
{
    return new
    {
        id = round.FixtureId,
        date = round.Date.ToString("yyyy-MM-dd"),
        status = "Complete",
        isLocked = true,
        maxTeams = 12,
        minimumScore = round.MinimumScore,
        site = new { id = OracleIds.Site(round.ID), name = $"Legacy Oracle Site {round.FixtureId}" },
        season = new { year = round.Date.Year },
        teams = round.RoundTeams.Select(roundTeam => new
        {
            id = OracleIds.Team(roundTeam.Team.ID),
            teamName = roundTeam.Team.TeamName,
            club = new { id = OracleIds.Club(roundTeam.Team.Club.ID), name = roundTeam.Team.Club.Name },
            score = 0,
            pilots = roundTeam.RoundTeamPlaces.OrderBy(place => place.PlaceInTeam).Select(place => ToPilotSlotJson(place, slotIdsByLegacyPilotId[place.RoundTeamPilot.ID])),
        }),
    };
}

static object ToPilotSlotJson(RoundTeamPlace place, SlotIds ids)
{
    PilotDefinition pilot = ids.PilotDefinition;
    Dictionary<string, object?> slot = new()
    {
        ["placeInTeam"] = pilot.PlaceInTeam,
        ["isScoring"] = pilot.IsScoring,
        ["status"] = pilot.Status,
        ["accountedFor"] = pilot.AccountedFor,
        ["signToFly"] = pilot.SignToFly,
        ["noScore"] = pilot.NoScore,
        ["pilotPoints"] = 0,
        ["pilotId"] = ids.PilotId,
        ["snapshot"] = new
        {
            wingClass = pilot.WingClass,
            pilotRating = pilot.PilotRating,
        },
        ["flight"] = pilot.Distance is double distance && ids.FlightId is string flightId
            ? BuildFlightJson(pilot, distance, flightId)
            : null,
    };
    return slot;
}

static Dictionary<string, object?> BuildFlightJson(PilotDefinition pilot, double distance, string flightId)
{
    Dictionary<string, object?> flight = new()
    {
        ["id"] = flightId,
        ["distance"] = distance,
        ["scoringType"] = pilot.ScoringType,
        ["score"] = 0,
        ["wingFactor"] = 0,
        ["isManualLog"] = pilot.IsManualLog,
    };

    if (pilot.ManualLogJustification is not null)
    {
        flight.Add("manualLogJustification", pilot.ManualLogJustification);
    }

    return flight;
}

static void AssertSelfConsistent(string roundId, RoundDerivation derivation)
{
    float bestPilotPoints = derivation.Pilots.Count == 0 ? 0 : derivation.Pilots.Max(pilot => pilot.PilotPoints);
    if (Math.Abs(bestPilotPoints - derivation.MaxPointsForRound) > 0.05f)
    {
        throw new InvalidOperationException($"{roundId}: best pilot points {bestPilotPoints} do not match maxPointsForRound {derivation.MaxPointsForRound}.");
    }

    float bestTeamScore = derivation.Teams.Count == 0 ? 0 : derivation.Teams.Max(team => team.Score);
    float roundedMaxPoints = (float)Math.Round(derivation.MaxPointsForRound, 0);
    if (Math.Abs(bestTeamScore - roundedMaxPoints) > 0.05f)
    {
        throw new InvalidOperationException($"{roundId}: best team score {bestTeamScore} does not match rounded maxPointsForRound {roundedMaxPoints}.");
    }
}

static object ConfigJson()
{
    return new
    {
        maxTeamsInClub = 2,
        maxPilotsInTeam = 9,
        maxScoringPilotsInTeam = 6,
        maxPilotScoresCountedPerTeam = 4,
        leagueRoundScoresCounted = 6,
        flightDateValidationEnabled = true,
        wingFactors = new Dictionary<string, float>
        {
            ["EN A"] = 1.0f,
            ["EN B"] = 0.9f,
            ["EN C"] = 0.8f,
            ["EN C 2-liner"] = 0.7f,
            ["EN D"] = 0.6f,
            ["EN D 2-liner"] = 0.5f,
        },
        taskMaxPoints = 1000,
        pilotFactors = new Dictionary<string, float>
        {
            ["Club Pilot"] = 1,
            ["Pilot"] = 1,
            ["Advanced Pilot"] = 0.9f,
        },
        clubsAttendingFactors = new
        {
            fewerThanThreeClubs = 0.5f,
            exactlyThreeClubs = 0.75f,
            moreThanThreeClubs = 1,
        },
        minDistanceFactors = new
        {
            oneFlight = 0.2f,
            twoFlights = 0.4f,
            threeFlights = 0.6f,
            fourFlights = 0.8f,
            fiveOrMoreFlights = 1,
        },
    };
}

static int StableInt(string value)
{
    int hash = 17;
    foreach (char character in value)
    {
        hash = unchecked((hash * 31) + character);
    }

    return Math.Abs(hash);
}

static string FindRepoRoot(string start)
{
    DirectoryInfo? directory = new(start);
    while (directory is not null)
    {
        if (File.Exists(Path.Combine(directory.FullName, "package.json"))
            && Directory.Exists(Path.Combine(directory.FullName, "packages")))
        {
            return directory.FullName;
        }

        directory = directory.Parent;
    }

    throw new InvalidOperationException("Could not find repo root for scoring oracle.");
}
