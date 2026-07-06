using System.Text.Json.Serialization;

namespace ScoringOracle;

public sealed record ScenarioSet(
    string LegacyHash,
    string CapturedAt,
    List<ScenarioDefinition> Scenarios);

public sealed record ScenarioDefinition(
    string Id,
    string Label,
    string Notes,
    List<RoundDefinition> Rounds);

public sealed record RoundDefinition(
    string Id,
    string Date,
    float MinimumScore,
    string SiteName,
    List<TeamDefinition> Teams);

public sealed record TeamDefinition(
    string Id,
    string TeamName,
    string ClubId,
    string ClubName,
    List<PilotDefinition> Pilots);

public sealed record PilotDefinition(
    int PlaceInTeam,
    string WingClass,
    string PilotRating,
    double? Distance,
    bool IsScoring = true,
    string Status = "Filled",
    bool NoScore = false,
    bool AccountedFor = true,
    bool SignToFly = true,
    string ScoringType = "XC",
    bool IsManualLog = false,
    string? ManualLogJustification = null);

public sealed record BuiltRound(Round Round, LegacyDb Db, Dictionary<int, SlotIds> SlotIdsByLegacyPilotId);

public sealed record SlotIds(
    string TeamId,
    int PlaceInTeam,
    string PilotId,
    string? FlightId,
    PilotDefinition PilotDefinition);

public sealed record RoundDerivation(
    int TaskMaxPoints,
    int ClubsAttendingCount,
    float ClubsAttendingFactor,
    int MinDistanceFlightCount,
    float MinDistanceFactor,
    float MaxPointsForRound,
    float MaxPilotScoreInRound,
    int MaxTeamScore,
    List<PilotExpected> Pilots,
    List<TeamExpected> Teams);

public sealed record PilotExpected(
    string TeamId,
    int PlaceInTeam,
    string PilotId,
    float RawScore,
    float PilotPoints);

public sealed record TeamExpected(string TeamId, int WorkingTeamScore, float Score);

public sealed record LeagueExpected(
    string TeamId,
    string ClubId,
    string TeamName,
    int TotalScore,
    int Rank,
    Dictionary<string, float> RoundScores,
    int CountedRounds);

public sealed record FixturePayload(
    string Name,
    string Scenario,
    string Notes,
    string LegacySource,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    int? LegacyId,
    string LegacyIdNote,
    string CapturedAt,
    FixtureInput Input,
    FixtureExpected Expected);

public sealed record FixtureInput(
    object Round,
    object Config,
    List<object>? SeasonRounds = null);

public sealed record FixtureExpected(
    RoundDerivation Round,
    List<PilotExpected> Pilots,
    List<TeamExpected> Teams,
    List<LeagueExpected> League);

public sealed record LeagueTeamSeasonViewModel
{
    public required string TeamId { get; init; }
    public required string ClubId { get; init; }
    public required string TeamName { get; init; }
    public int numRoundsInTotal { get; init; } = 6;
    public List<RoundTeam> RoundTeams { get; set; } = [];
    public int TotalScore { get; set; }
    public int Position { get; set; }
}

public sealed record ManifestTeam(float TeamScore, int WorkingTeamScore, Dictionary<string, float> Pilots);

public sealed class ScenarioBuildContext
{
    private readonly Dictionary<string, int> teamIdsByIdentity = [];
    private int nextTeamId = 50_000;

    public int GetTeamId(TeamDefinition team)
    {
        string identity = $"{team.ClubId}\u001f{team.TeamName}";
        if (!teamIdsByIdentity.TryGetValue(identity, out int teamId))
        {
            teamId = nextTeamId;
            nextTeamId++;
            teamIdsByIdentity.Add(identity, teamId);
        }

        return teamId;
    }
}
