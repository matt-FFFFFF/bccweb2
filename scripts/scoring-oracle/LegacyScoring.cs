namespace ScoringOracle;

public sealed class LegacyScoring
{
    private const string Wing_Class_EN_A = "EN A";
    private const string Wing_Class_EN_B = "EN B";
    private const string Wing_Class_EN_C = "EN C";
    private const string Wing_Class_EN_C2 = "EN C 2-liner";
    private const string Wing_Class_EN_D = "EN D";
    private const string Wing_Class_EN_D2 = "EN D 2-liner";
    private const string Pilot_Rating_Club_Pilot = "Club Pilot";
    private const string Pilot_Rating_Pilot = "Pilot";
    private const string Pilot_Rating_Advanced_Pilot = "Advanced Pilot";

    private readonly LegacyConfig config;
    private readonly LegacyDb db;

    public LegacyScoring(LegacyConfig config, LegacyDb db)
    {
        this.config = config;
        this.db = db;
    }

    public float GetPilotScore(Flight flight)
    {
        float pilotFactor = GetPilotFactor(flight);
        float wingFactor = GetWingfactor(flight);
        float distance = (float)flight.Distance;

        float scoreAfterPilotFactor = (float)(distance * pilotFactor);
        float pilotScore = (float)(scoreAfterPilotFactor * wingFactor);

        return pilotScore;
    }

    public float GetWingfactor(Flight flight)
    {
        if (flight.RoundTeamPilot.WingClass == Wing_Class_EN_A)
        {
            return config.WingFactor_EN_A;
        }
        else if (flight.RoundTeamPilot.WingClass == Wing_Class_EN_B)
        {
            return config.WingFactor_EN_B;
        }
        else if (flight.RoundTeamPilot.WingClass == Wing_Class_EN_C)
        {
            return config.WingFactor_EN_C;
        }
        else if (flight.RoundTeamPilot.WingClass == Wing_Class_EN_C2)
        {
            return config.WingFactor_EN_C2;
        }
        else if (flight.RoundTeamPilot.WingClass == Wing_Class_EN_D)
        {
            return config.WingFactor_EN_D;
        }
        else if (flight.RoundTeamPilot.WingClass == Wing_Class_EN_D2)
        {
            return config.WingFactor_EN_D2;
        }

        return 0;
    }

    public float GetPilotFactor(Flight flight)
    {
        float clubPilotFactor = 1;
        float pilotFactor = 1;
        float AdvancedPilotFactor = (float)0.9;

        if (flight.RoundTeamPilot.Pilot_Rating.Description == Pilot_Rating_Club_Pilot)
        {
            return clubPilotFactor;
        }
        else if (flight.RoundTeamPilot.Pilot_Rating.Description == Pilot_Rating_Pilot)
        {
            return pilotFactor;
        }
        else if (flight.RoundTeamPilot.Pilot_Rating.Description == Pilot_Rating_Advanced_Pilot)
        {
            return AdvancedPilotFactor;
        }

        return 0;
    }

    public float GetClubsAttendingFactor(Round round)
    {
        float clubsAttendingFactor = 0;
        int numClubs = round.RoundTeams
                        .Select(r => r.Team.Club).Distinct().Count();

        // switch can be used here alternatively
        if (numClubs < 3)
        {
            clubsAttendingFactor = (float)0.5;
        }
        else if (numClubs == 3)
        {
            clubsAttendingFactor = (float)0.75;
        }
        else if (numClubs > 3)
        {
            clubsAttendingFactor = (float)1;
        }

        return clubsAttendingFactor;
    }

    public float GetMinDistanceFactor(Round round)
    {
        float minDistanceFactor = 0;

        int numFlightsOver5k = db.Flights
                                 .Where(f => f.Round.ID == round.ID)
                                 .Where(f => f.Distance >= round.MinimumScore)
                                 .Count();

        // switch can be used here alternatively
        if (numFlightsOver5k == 1)
        {
            minDistanceFactor = (float)0.2;
        }
        else if (numFlightsOver5k == 2)
        {
            minDistanceFactor = (float)0.4;
        }
        else if (numFlightsOver5k == 3)
        {
            minDistanceFactor = (float)0.6;
        }
        else if (numFlightsOver5k == 4)
        {
            minDistanceFactor = (float)0.8;
        }
        else if (numFlightsOver5k > 4)
        {
            minDistanceFactor = 1;
        }

        return minDistanceFactor;
    }

    public void GetPilotPoints(Round round, RoundViewModel roundViewModel, float maxPointsForRound, int taskMaxScore, float clubsAttendingFactor, float minDistanceFactor)
    {
        float maxPilotScoreInRound = 0;

        foreach (Flight flight in roundViewModel.Flights)
        {
            FlightViewModel flightViewModel = new FlightViewModel
            {
                ID = flight.ID,
                RoundID = flight.RoundID,
                RoundTeamPilot = flight.RoundTeamPilot,
                RoundTeamPlace = flight.roundTeamPlace,
                PilotID = flight.RoundTeamPilot.Pilot.ID
            };
            flightViewModel.PilotScore = GetPilotScore(flight);
            roundViewModel.FlightViewModels.Add(flightViewModel);
        }
        if (roundViewModel.FlightViewModels.Count() > 0)
        {
            maxPilotScoreInRound = roundViewModel.FlightViewModels.OrderByDescending(f => f.PilotScore).First().PilotScore;
            int highestScoringPilotID = roundViewModel.FlightViewModels.OrderByDescending(f => f.PilotScore).First().PilotID;

            foreach (RoundTeamPilot roundTeamPilot in roundViewModel.RoundTeamPilots)
            {
                Flight flight = db.Flights.Where(f => f.RoundTeamPilot.ID == roundTeamPilot.ID).Include(p => p.Pilot.Pilot_Rating).FirstOrDefault();
                roundTeamPilot.PilotPoints = (float)(maxPointsForRound * GetPilotScore(flight) / maxPilotScoreInRound);
            }
        }
        else
        {
            foreach (RoundTeamPilot roundTeamPilot in roundViewModel.RoundTeamPilots)
            {
                roundTeamPilot.PilotPoints = 0;
            }
        }

        db.SaveChanges();

        return;
    }

    public int GetWorkingTeamScore(RoundTeam roundTeam)
    {
        int topNScoresInTeam = 4;
        int countOfScores = 0;
        float sumTopScores = 0;

        var sumTop4PilotPoints =
            roundTeam.RoundTeamPlaces
                .Where(r => r.IsScoring)
                .Where(r => r.Status == RoundTeamPlace.RoundTeamPlaceStatuses.Filled.ToString())
                .OrderByDescending(r => r.RoundTeamPilot.PilotPoints)
                .Select(r => r.RoundTeamPilot.PilotPoints);

        foreach (var item in sumTop4PilotPoints)
        {
            float f = (float)item;
            sumTopScores += f;
            countOfScores++;

            if (countOfScores == topNScoresInTeam) { break; }
        }

        return (int)sumTopScores;
    }

    public int GetMaxTeamScore(ICollection<RoundTeamViewModel> roundTeamViewModels)
    {
        return roundTeamViewModels.Max(r => (int)r.WorkingTeamScore);
    }

    public void GetTeamScores(Round round, RoundViewModel roundViewModel, float maxPointsForRound)
    {
        int maxTeamScore = 0;

        foreach (RoundTeam roundTeam in roundViewModel.RoundTeams)
        {
            RoundTeamViewModel roundTeamViewModel = new RoundTeamViewModel { ID = roundTeam.ID, Round = roundTeam.Round, Team = roundTeam.Team };
            roundTeamViewModel.WorkingTeamScore = GetWorkingTeamScore(roundTeam);
            roundViewModel.RoundTeamViewModels.Add(roundTeamViewModel);
        }

        maxTeamScore = GetMaxTeamScore(roundViewModel.RoundTeamViewModels);

        foreach (RoundTeamViewModel roundTeamViewModel in roundViewModel.RoundTeamViewModels)
        {
            RoundTeam roundTeam = roundViewModel.RoundTeams.Where(r => r.ID == roundTeamViewModel.ID).FirstOrDefault();

            if (maxTeamScore != 0)
            {
                roundTeam.TeamScore =
                    (float)Math.Round((maxPointsForRound * roundTeamViewModel.WorkingTeamScore) / maxTeamScore, 0);
            }
            else
            {
                roundTeam.TeamScore = 0;
            }
        }

        return;
    }

    public RoundViewModel GetRoundViewModelForScoring(Round round)
    {
        RoundViewModel roundViewModel = round.ToViewModel();

        roundViewModel.FlightViewModels = new List<FlightViewModel>();
        roundViewModel.RoundTeamViewModels = new List<RoundTeamViewModel>();

        roundViewModel.Flights = db.Flights
                                   .Where(f => f.Round.ID == round.ID)
                                   .Include(f => f.RoundTeamPilot)
                                   .OrderByDescending(f => f.Distance)
                                   .ToList<Flight>();

        roundViewModel.RoundTeamPilots = roundViewModel.Flights
                                          .Select(p => p.RoundTeamPilot)
                                          .ToList<RoundTeamPilot>();

        return roundViewModel;
    }

    public Round ScoreRound(Round round)
    {
        // Hard-coding for XC only for now. In due course this could be a DD in the Rounds create view
        int taskMaxPoints = 1000;

        float clubsAttendingFactor = GetClubsAttendingFactor(round);
        float minDistanceFactor = GetMinDistanceFactor(round);
        float maxPointsForRound = taskMaxPoints * clubsAttendingFactor * minDistanceFactor;
        RoundViewModel roundViewModel = GetRoundViewModelForScoring(round);
        GetPilotPoints(round, roundViewModel, maxPointsForRound, taskMaxPoints, clubsAttendingFactor, minDistanceFactor);
        GetTeamScores(round, roundViewModel, maxPointsForRound);

        return round;
    }
}
