namespace ScoringOracle;

public sealed class LegacyConfig
{
    public float WingFactor_EN_A { get; init; } = 1.0f;
    public float WingFactor_EN_B { get; init; } = 0.9f;
    public float WingFactor_EN_C { get; init; } = 0.8f;
    public float WingFactor_EN_C2 { get; init; } = 0.7f;
    public float WingFactor_EN_D { get; init; } = 0.6f;
    public float WingFactor_EN_D2 { get; init; } = 0.5f;
}

public sealed class LegacyDb
{
    public List<Flight> Flights { get; } = [];

    public void SaveChanges()
    {
    }
}

public sealed class Club
{
    public required int ID { get; init; }
    public required string Name { get; init; }
}

public sealed class Team
{
    public required int ID { get; init; }
    public required string TeamName { get; init; }
    public required Club Club { get; init; }
    public int ClubID => Club.ID;
}

public sealed class PilotRating
{
    public required string Description { get; init; }
}

public sealed class Pilot
{
    public required int ID { get; init; }
    public required PilotRating Pilot_Rating { get; init; }
}

public sealed class RoundTeamPilot
{
    public required int ID { get; init; }
    public required Pilot Pilot { get; init; }
    public required string WingClass { get; init; }
    public PilotRating Pilot_Rating => Pilot.Pilot_Rating;
    public float PilotPoints { get; set; }
}

public sealed class RoundTeamPlace
{
    public enum RoundTeamPlaceStatuses
    {
        Empty,
        Filled,
        Vacant,
    }

    public required int PlaceInTeam { get; init; }
    public required bool IsScoring { get; init; }
    public required string Status { get; init; }
    public required bool NoScore { get; init; }
    public required RoundTeam RoundTeam { get; init; }
    public required RoundTeamPilot RoundTeamPilot { get; init; }
}

public sealed class RoundTeam
{
    public required int ID { get; init; }
    public required Round Round { get; init; }
    public required Team Team { get; init; }
    public List<RoundTeamPlace> RoundTeamPlaces { get; } = [];
    public float TeamScore { get; set; }
}

public sealed class Round
{
    public required int ID { get; init; }
    public required string FixtureId { get; init; }
    public required DateOnly Date { get; init; }
    public required float MinimumScore { get; init; }
    public List<RoundTeam> RoundTeams { get; } = [];

    public RoundViewModel ToViewModel()
    {
        return new RoundViewModel { ID = ID, RoundTeams = RoundTeams };
    }
}

public sealed class Flight
{
    public required int ID { get; init; }
    public required int RoundID { get; init; }
    public required Round Round { get; init; }
    public required RoundTeamPilot RoundTeamPilot { get; init; }
    public required RoundTeamPlace roundTeamPlace { get; init; }
    public required double Distance { get; init; }
    public Pilot Pilot => RoundTeamPilot.Pilot;
    public RoundTeam roundTeam => roundTeamPlace.RoundTeam;
}

public sealed class FlightViewModel
{
    public int ID { get; init; }
    public int RoundID { get; init; }
    public RoundTeamPilot? RoundTeamPilot { get; init; }
    public RoundTeamPlace? RoundTeamPlace { get; init; }
    public int PilotID { get; init; }
    public float PilotScore { get; set; }
}

public sealed class RoundTeamViewModel
{
    public int ID { get; init; }
    public Round? Round { get; init; }
    public Team? Team { get; init; }
    public float WorkingTeamScore { get; set; }
}

public sealed class RoundViewModel
{
    public int ID { get; init; }
    public List<Flight> Flights { get; set; } = [];
    public List<FlightViewModel> FlightViewModels { get; set; } = [];
    public List<RoundTeamViewModel> RoundTeamViewModels { get; set; } = [];
    public List<RoundTeam> RoundTeams { get; set; } = [];
    public List<RoundTeamPilot> RoundTeamPilots { get; set; } = [];
}

public static class EfShim
{
    public static IEnumerable<T> Include<T, TProperty>(
        this IEnumerable<T> source,
        Func<T, TProperty> path)
    {
        return source;
    }
}
