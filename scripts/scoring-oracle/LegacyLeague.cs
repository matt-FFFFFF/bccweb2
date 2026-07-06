namespace ScoringOracle;

public sealed class LegacyLeague
{
    public List<LeagueExpected> Compute(List<Round> rounds)
    {
        Dictionary<string, LeagueTeamSeasonViewModel> teamsById = [];

        foreach (Round round in rounds)
        {
            foreach (RoundTeam roundTeam in round.RoundTeams)
            {
                string teamId = OracleIds.Team(roundTeam.Team.ID);
                if (!teamsById.TryGetValue(teamId, out LeagueTeamSeasonViewModel? leagueTeamSeasonViewModel))
                {
                    leagueTeamSeasonViewModel = new LeagueTeamSeasonViewModel
                    {
                        TeamId = teamId,
                        ClubId = OracleIds.Club(roundTeam.Team.Club.ID),
                        TeamName = roundTeam.Team.TeamName,
                    };
                    teamsById.Add(teamId, leagueTeamSeasonViewModel);
                }

                leagueTeamSeasonViewModel.RoundTeams.Add(roundTeam);
            }
        }

        List<LeagueTeamSeasonViewModel> leagueTeamSeasonViewModels = [];
        foreach (LeagueTeamSeasonViewModel leagueTeamSeasonViewModel in teamsById.Values)
        {
            leagueTeamSeasonViewModel.RoundTeams = GetRoundTeams(leagueTeamSeasonViewModel.RoundTeams, leagueTeamSeasonViewModel.numRoundsInTotal);
            leagueTeamSeasonViewModel.TotalScore = GetTotalScore(leagueTeamSeasonViewModel, leagueTeamSeasonViewModel.numRoundsInTotal);
            leagueTeamSeasonViewModels.Add(leagueTeamSeasonViewModel);
        }

        leagueTeamSeasonViewModels = leagueTeamSeasonViewModels.OrderByDescending(s => s.TotalScore).ToList<LeagueTeamSeasonViewModel>();

        int i = 1;
        foreach (LeagueTeamSeasonViewModel leagueTeamSeasonViewModel in leagueTeamSeasonViewModels)
        {
            leagueTeamSeasonViewModel.Position = i;
            i++;
        }

        return leagueTeamSeasonViewModels
            .Select(team => new LeagueExpected(
                team.TeamId,
                team.ClubId,
                team.TeamName,
                team.TotalScore,
                team.Position,
                team.RoundTeams.ToDictionary(roundTeam => roundTeam.Round.FixtureId, roundTeam => roundTeam.TeamScore),
                team.RoundTeams.Count))
            .ToList();
    }

    private int GetTotalScore(LeagueTeamSeasonViewModel leagueTeamSeasonViewModel, int numRoundsInTotal)
    {
        int totalScore = (int)leagueTeamSeasonViewModel.RoundTeams
                    .OrderByDescending(r => r.TeamScore)
                    .Take(numRoundsInTotal)
                    .Sum(x => x.TeamScore);

        return totalScore;
    }

    private List<RoundTeam> GetRoundTeams(List<RoundTeam> roundTeams, int numRoundsInTotal)
    {
        List<RoundTeam> selectedRoundTeams = roundTeams
                                       .OrderByDescending(r => r.TeamScore)
                                       .Take(numRoundsInTotal)
                                       .ToList<RoundTeam>();

        return selectedRoundTeams;
    }
}
