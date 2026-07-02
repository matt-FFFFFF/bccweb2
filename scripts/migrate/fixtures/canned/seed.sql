-- seed.sql — Synthetic seed data for migration smoke test.
--
-- 100% SYNTHETIC — no real pilot names, emails, phone numbers, or
-- medical/equipment data. Names are obviously fake ("Test Alpha",
-- "Synthetic Pilot N"); emails use the IANA-reserved .test TLD;
-- phone numbers are RFC 5733 reserved ranges.
--
-- Counts:
--   Statuses          : 6
--   Manufacturers     : 3
--   PilotRatings      : 3
--   Clubs             : 3
--   Frequencies       : 3
--   Sites             : 3
--   Seasons           : 2
--   SeasonClubs       : 3 (one per club in 2026)
--   SeasonClubFreqs   : 3
--   People            : 3
--   AspNetUsers       : 3
--   Pilots            : 3
--   PilotSeasonClubs  : 3
--   PilotClub         : 3
--   Teams             : 3
--   Rounds            : 3 (1 Confirmed proposed, 1 Complete, 1 Deleted/siteless)
--   RoundTeams        : 3 (all in the Complete round)
--   RoundTeamPilots   : 3
--   RoundTeamPlaces   : 9 (3 places per team)
--   Flights           : 3
--   RoundBriefs       : 1
--   RoundClubPilots   : 2 (discarded — count only)

-- ── Statuses ────────────────────────────────────────────────────────────────
INSERT INTO Statuses (ID, Description) VALUES
  (1, 'Proposed'),
  (2, 'Confirmed'),
  (6, 'Active'),
  (9, 'Complete'),
  (10, 'Deleted'),
  (11, 'Brief Complete');

-- ── Manufacturers ────────────────────────────────────────────────────────────
INSERT INTO Manufacturers (ID, Name, WebsiteUrl) VALUES
  (1, 'TestMfr Alpha', 'https://example.test/alpha'),
  (2, 'TestMfr Bravo', 'https://example.test/bravo'),
  (3, 'TestMfr Charlie', NULL);

-- ── PilotRatings ─────────────────────────────────────────────────────────────
INSERT INTO PilotRatings (ID, Description) VALUES
  (1, 'CP'),
  (2, 'Pilot'),
  (3, 'Advanced Pilot');

-- ── Clubs ────────────────────────────────────────────────────────────────────
INSERT INTO Clubs (ID, Name) VALUES
  (1, 'Test Club Alpha'),
  (2, 'Test Club Bravo'),
  (3, 'Test Club Charlie');

-- ── Frequencies ──────────────────────────────────────────────────────────────
INSERT INTO Frequencies (ID, Freq, Position) VALUES
  (1, '145.500', 1),
  (2, '145.525', 2),
  (3, '145.550', 3);

-- ── Sites ────────────────────────────────────────────────────────────────────
INSERT INTO Sites (ID, Name, Club_ID, StatusID, SiteGuideURL, ParkingW3W, BriefingW3W, TakeOffW3W) VALUES
  (1, 'Test Site Alpha', 1, 6,    'https://example.test/sites/alpha', 'apple.banana.cherry', 'date.elder.fig',     'grape.honey.iris'),
  (2, 'Test Site Bravo', 2, 6,    NULL,                                'jade.kiwi.lemon',     NULL,                  'mango.nectar.olive'),
  (3, 'Test Site Charlie', 3, NULL, NULL,                              NULL,                  NULL,                  NULL);

-- ── Seasons ──────────────────────────────────────────────────────────────────
INSERT INTO Seasons (ID, Year, MaxTeams, active) VALUES
  (1, 2025, 8, 0),
  (2, 2026, 8, 1);

-- ── SeasonClubs ──────────────────────────────────────────────────────────────
INSERT INTO SeasonClubs (ID, Season_ID, Club_ID, NumTeams, AcceptTsCs) VALUES
  (1, 2, 1, 2, 1),
  (2, 2, 2, 1, 1),
  (3, 2, 3, 1, 0);

-- ── SeasonClubFrequencies ─────────────────────────────────────────────────────
INSERT INTO SeasonClubFrequencies (ID, Frequency_ID) VALUES
  (1, 1),
  (2, 2),
  (3, 3);

-- ── People ───────────────────────────────────────────────────────────────────
INSERT INTO People (ID, FirstName, LastName, FullName, PhoneNumber) VALUES
  (101, 'Synthetic', 'Alpha',   'Synthetic Alpha',   '+44-1632-960001'),
  (102, 'Synthetic', 'Bravo',   'Synthetic Bravo',   '+44-1632-960002'),
  (103, '',          'Charlie', 'Synthetic Charlie', NULL);

-- ── AspNetUsers ──────────────────────────────────────────────────────────────
INSERT INTO AspNetUsers (Id, Email) VALUES
  ('user-alpha-101',   'alpha@example.test'),
  ('user-bravo-102',   'bravo@example.test'),
  ('user-charlie-103', NULL);

-- ── Pilots ───────────────────────────────────────────────────────────────────
INSERT INTO Pilots (ID, BHPA_Number, CoachType, PersonID, UserID, PureTrackLink, PureTrackID, Pilot_Rating_ID, Manufacturer_ID,
                    HelmetColour, HarnessType, HarnessColour, EmergencyContactName, EmergencyPhoneNumber, MedicalInfo,
                    WingModel, WingClass, WingColours) VALUES
  (201, 11111, 0, 101, 'user-alpha-101',   'https://puretrack.io/user/alpha',   1001, 2, 1,
   'Red', 'Pod', 'Black', 'Synthetic ICE Alpha', '+44-1632-960101', NULL,
   'Mentor 7', 'EN B', 'Red/Blue'),
  (202, 22222, 1, 102, 'user-bravo-102',   'https://puretrack.io/user/bravo',      0, 1, 2,
   'White', 'Reversible', 'Blue', 'Synthetic ICE Bravo', '+44-1632-960102', 'None',
   'Zeno 2', 'EN D 2-liner', 'Yellow/Green'),
  (203, NULL,  3, 103, 'user-charlie-103', NULL,                                   0, 3, NULL,
   NULL,  NULL,         NULL,    NULL,                   NULL,                NULL,
   NULL,        'EN A',         NULL);

-- ── PilotSeasonClubs ─────────────────────────────────────────────────────────
INSERT INTO PilotSeasonClubs (ID, pilot_ID, season_ID, club_ID) VALUES
  (1, 201, 2, 1),
  (2, 202, 2, 2),
  (3, 203, 2, 3);

-- ── PilotClub (historical memberships) ───────────────────────────────────────
INSERT INTO PilotClub (ID, Pilot_ID, Club_ID, JoinedAt, LeftAt) VALUES
  (1, 201, 1, '2024-03-01T00:00:00', NULL),
  (2, 202, 3, '2023-04-01T00:00:00', '2025-09-30T00:00:00'),
  (3, 202, 2, '2025-10-01T00:00:00', NULL);

-- ── Teams ────────────────────────────────────────────────────────────────────
INSERT INTO Teams (ID, ClubID, SeasonID, TeamName) VALUES
  (301, 1, 2, 'Test Club Alpha A'),
  (302, 2, 2, 'Test Club Bravo A'),
  (303, NULL, 2, 'Test Club Charlie A');

-- ── Rounds ───────────────────────────────────────────────────────────────────
-- Round 401: Confirmed, no teams (no flights), no brief
-- Round 402: Complete, 3 teams each with a flight; one brief
-- Round 403: Deleted legacy row with no site
INSERT INTO Rounds (ID, Date, SiteID, StatusID, isLocked, OrganisingClub_ID, Season_ID, MaxTeams, MinimumScore,
                    BriefingTime, LandByTime, CheckInByTime, Narrative,
                    PureTrackGroupName, PureTrackGroupSlug, PureTrackGroup_ID) VALUES
  (401, '2026-06-13T00:00:00', 1, 2, 0, 1, 2, 8, 0,
   '2026-06-13T08:00:00', '2026-06-13T18:00:00', '2026-06-13T09:00:00', 'Synthetic confirmed round.',
   'Not set yet...', 'Not set yet...', NULL),
  (402, '2026-05-20T00:00:00', 2, 9, 1, 2, 2, 8, 0,
   '2026-05-20T08:30:00', '2026-05-20T17:30:00', '2026-05-20T09:30:00', 'Synthetic complete round.',
   'BCC 2026 Round 1', 'bcc-2026-r1', 9001),
  (403, '2026-07-11T00:00:00', NULL, 10, 0, 3, 2, 8, 0,
   NULL, NULL, NULL, 'Synthetic deleted siteless round.',
   'Not set yet...', 'Not set yet...', NULL);

-- ── RoundTeams (only round 402) ──────────────────────────────────────────────
INSERT INTO RoundTeams (ID, RoundID, TeamID, TeamScore, PureTrackGroupName, PureTrackGroupSlug, PureTrackGroup_ID) VALUES
  (501, 402, 301, 0.0, 'BCC 2026 R1 Alpha A',   'bcc-2026-r1-alpha-a',   9101),
  (502, 402, 302, 0.0, 'BCC 2026 R1 Bravo A',   'bcc-2026-r1-bravo-a',   9102),
  (503, 402, 303, 0.0, NULL,                    NULL,                    NULL);

-- ── RoundTeamPilots ──────────────────────────────────────────────────────────
INSERT INTO RoundTeamPilots (ID, Pilot_ID, noScore, PilotPoints, PhoneNumber, Pilot_Rating_ID, WingClass, Manufacturer_ID,
                             WingModel, WingColours, HelmetColour, HarnessType, HarnessColour,
                             EmergencyContactName, EmergencyPhoneNumber, MedicalInfo, AccountedFor, SignToFly) VALUES
  (601, 201, 0, 0.0, '+44-1632-960001', 2, 'EN_B',         1, 'Mentor 7', 'Red/Blue',     'Red',   'Pod',        'Black', 'Synthetic ICE Alpha',   '+44-1632-960101', NULL,   1, 1),
  (602, 202, 0, 0.0, '+44-1632-960002', 1, 'EN D 2-liner', 2, 'Zeno 2',   'Yellow/Green', 'White', 'Reversible', 'Blue',  'Synthetic ICE Bravo',   '+44-1632-960102', 'None', 1, 1),
  (603, 203, 0, 0.0, NULL,              3, 'EN A',         3, NULL,       NULL,           NULL,    NULL,         NULL,    NULL,                    NULL,              NULL,   1, 0);

-- ── RoundTeamPlaces (3 places per team — place 1 filled in each) ─────────────
INSERT INTO RoundTeamPlaces (ID, PlaceInTeam, IsScoring, Status, RoundTeam_ID, RoundTeamPilot_ID) VALUES
  (701, 1, 1, 'Filled', 501, 601),
  (702, 2, 1, 'Empty',  501, NULL),
  (703, 3, 0, 'Empty',  501, NULL),
  (704, 1, 1, 'Filled', 502, 602),
  (705, 2, 1, 'Empty',  502, NULL),
  (706, 3, 0, 'Empty',  502, NULL),
  (707, 1, 1, 'Filled', 503, 603),
  (708, 2, 1, 'Empty',  503, NULL),
  (709, 3, 0, 'Empty',  503, NULL);

-- ── Flights (one per place-1 pilot in the Complete round) ────────────────────
INSERT INTO Flights (ID, PilotID, RoundID, DateTime, Distance, url, ScoringType, isManualLog,
                     IsOverallPB, AwardedOverallPB, IsUKPersonalBest, AwardedUKPersonalBest,
                     IsFirstXC, AwardedFirstXC, IsFirstUKXC, AwardedFirstUKXC, roundTeamPlace_ID) VALUES
  (801, 201, 402, '2026-05-20T11:00:00', 42.500, 'https://example.test/tracks/801', 'puretrack', 0,
   1, 1, 0, 0, 0, 0, 0, 0, 701),
  (802, 202, 402, '2026-05-20T11:30:00', 71.250, 'https://example.test/tracks/802', 'manual', 1,
   0, 0, 1, 1, 0, 0, 0, 0, 704),
  (803, 203, 402, '2026-05-20T10:45:00', 18.000, 'https://example.test/tracks/803', 'XC', 0,
   0, 0, 0, 0, 1, 1, 1, 1, 707);

-- ── RoundBriefs (one for the Complete round) ─────────────────────────────────
INSERT INTO RoundBriefs (ID, RoundID, SiteName, BrieferName, BrieferBHPA_CoachLevel, BrieferBHPA_Number,
                         BrieferPhoneNumber, BrieferEmailAddress, RoundDate, OrganisingClubName,
                         BriefingTime, LandByTime, CheckInByTime, NumTeamsInRound, NumPilotsInRound,
                         WindSpeed_Direction, DirectionOfFlight, ExpectedLandingArea,
                         AirspaceAndHazards, NOTAMs, BENO_LineDescription, BriefersNotes, Image) VALUES
  (901, 402, 'Test Site Bravo', 'Synthetic Briefer', 'Club Coach', '99999',
   '+44-1632-960900', 'briefer@example.test', NULL, 'Test Club Bravo',
   '2026-05-20T08:30:00', '2026-05-20T17:30:00', '2026-05-20T09:30:00', 3, 3,
   '10 kt W', 'NNE', 'Synthetic LZ 1km east of takeoff',
   'Synthetic airspace notes', 'Synthetic NOTAM text', 'Synthetic BENO line',
   'Synthetic briefer notes', NULL);

-- ── RoundClubPilots (discarded — count only) ────────────────────────────────
INSERT INTO RoundClubPilots (ID, Pilot_ID, Round_ID, Club_ID) VALUES
  (1001, 203, 402, 3),
  (1002, 201, 401, 1);
