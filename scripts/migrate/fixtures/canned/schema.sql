-- schema.sql — Canned legacy BCCWeb schema for migration smoke tests.
--
-- Synthetic, narrow subset of the real BCCWeb SQL schema; covers every
-- table queried by scripts/migrate/migrate.mjs. NVARCHAR(MAX) is used
-- generously to keep types portable across SQL Server flavours.

CREATE TABLE Statuses (
  ID INT NOT NULL PRIMARY KEY,
  Description NVARCHAR(64) NOT NULL
);

CREATE TABLE Manufacturers (
  ID INT NOT NULL PRIMARY KEY,
  Name NVARCHAR(128) NOT NULL,
  WebsiteUrl NVARCHAR(256) NULL
);

CREATE TABLE PilotRatings (
  ID INT NOT NULL PRIMARY KEY,
  Description NVARCHAR(64) NOT NULL
);

CREATE TABLE Clubs (
  ID INT NOT NULL PRIMARY KEY,
  Name NVARCHAR(128) NOT NULL
);

CREATE TABLE Sites (
  ID INT NOT NULL PRIMARY KEY,
  Name NVARCHAR(128) NOT NULL,
  Club_ID INT NULL,
  StatusID INT NULL,
  SiteGuideURL NVARCHAR(256) NULL,
  ParkingW3W NVARCHAR(64) NULL,
  BriefingW3W NVARCHAR(64) NULL,
  TakeOffW3W NVARCHAR(64) NULL
);

CREATE TABLE Seasons (
  ID INT NOT NULL PRIMARY KEY,
  Year INT NOT NULL,
  MaxTeams INT NULL,
  active BIT NOT NULL
);

CREATE TABLE Frequencies (
  ID INT NOT NULL PRIMARY KEY,
  Freq NVARCHAR(32) NOT NULL,
  Position INT NOT NULL
);

CREATE TABLE SeasonClubs (
  ID INT NOT NULL PRIMARY KEY,
  Season_ID INT NULL,
  Club_ID INT NULL,
  NumTeams INT NULL,
  AcceptTsCs BIT NOT NULL
);

CREATE TABLE SeasonClubFrequencies (
  ID INT NOT NULL PRIMARY KEY,
  Frequency_ID INT NOT NULL
);

CREATE TABLE People (
  ID INT NOT NULL PRIMARY KEY,
  FirstName NVARCHAR(64) NULL,
  LastName NVARCHAR(64) NULL,
  FullName NVARCHAR(128) NULL,
  PhoneNumber NVARCHAR(32) NULL
);

CREATE TABLE AspNetUsers (
  Id NVARCHAR(128) NOT NULL PRIMARY KEY,
  Email NVARCHAR(256) NULL
);

CREATE TABLE Pilots (
  ID INT NOT NULL PRIMARY KEY,
  BHPA_Number INT NULL,
  CoachType INT NOT NULL,
  PersonID INT NULL,
  UserID NVARCHAR(128) NULL,
  PureTrackLink NVARCHAR(256) NULL,
  PureTrackID INT NOT NULL DEFAULT 0,
  Pilot_Rating_ID INT NOT NULL,
  Manufacturer_ID INT NULL,
  HelmetColour NVARCHAR(32) NULL,
  HarnessType NVARCHAR(32) NULL,
  HarnessColour NVARCHAR(32) NULL,
  EmergencyContactName NVARCHAR(128) NULL,
  EmergencyPhoneNumber NVARCHAR(32) NULL,
  MedicalInfo NVARCHAR(MAX) NULL,
  WingModel NVARCHAR(64) NULL,
  WingClass NVARCHAR(16) NULL,
  WingColours NVARCHAR(64) NULL
);

CREATE TABLE PilotSeasonClubs (
  ID INT NOT NULL PRIMARY KEY,
  pilot_ID INT NOT NULL,
  season_ID INT NOT NULL,
  club_ID INT NULL
);

CREATE TABLE PilotClub (
  ID INT NOT NULL PRIMARY KEY,
  Pilot_ID INT NOT NULL,
  Club_ID INT NULL,
  JoinedAt DATETIME2 NULL,
  LeftAt DATETIME2 NULL
);

CREATE TABLE Teams (
  ID INT NOT NULL PRIMARY KEY,
  ClubID INT NULL,
  SeasonID INT NULL,
  TeamName NVARCHAR(128) NOT NULL
);

CREATE TABLE Rounds (
  ID INT NOT NULL PRIMARY KEY,
  Date DATETIME2 NULL,
  SiteID INT NULL,
  StatusID INT NULL,
  isLocked BIT NOT NULL DEFAULT 0,
  OrganisingClub_ID INT NULL,
  Season_ID INT NULL,
  MaxTeams INT NULL,
  MinimumScore INT NULL,
  BriefingTime DATETIME2 NULL,
  LandByTime DATETIME2 NULL,
  CheckInByTime DATETIME2 NULL,
  Narrative NVARCHAR(MAX) NULL,
  PureTrackGroupName NVARCHAR(128) NULL,
  PureTrackGroupSlug NVARCHAR(128) NULL,
  PureTrackGroup_ID INT NULL
);

CREATE TABLE RoundTeams (
  ID INT NOT NULL PRIMARY KEY,
  RoundID INT NOT NULL,
  TeamID INT NOT NULL,
  TeamScore FLOAT NULL,
  PureTrackGroupName NVARCHAR(128) NULL,
  PureTrackGroupSlug NVARCHAR(128) NULL,
  PureTrackGroup_ID INT NULL
);

CREATE TABLE RoundTeamPilots (
  ID INT NOT NULL PRIMARY KEY,
  Pilot_ID INT NOT NULL,
  noScore BIT NOT NULL DEFAULT 0,
  PilotPoints FLOAT NULL,
  PhoneNumber NVARCHAR(32) NULL,
  Pilot_Rating_ID INT NULL,
  WingClass NVARCHAR(16) NULL,
  Manufacturer_ID INT NULL,
  WingModel NVARCHAR(64) NULL,
  WingColours NVARCHAR(64) NULL,
  HelmetColour NVARCHAR(32) NULL,
  HarnessType NVARCHAR(32) NULL,
  HarnessColour NVARCHAR(32) NULL,
  EmergencyContactName NVARCHAR(128) NULL,
  EmergencyPhoneNumber NVARCHAR(32) NULL,
  MedicalInfo NVARCHAR(MAX) NULL,
  AccountedFor BIT NOT NULL DEFAULT 0,
  SignToFly BIT NOT NULL DEFAULT 0
);

CREATE TABLE RoundTeamPlaces (
  ID INT NOT NULL PRIMARY KEY,
  PlaceInTeam INT NOT NULL,
  IsScoring BIT NOT NULL DEFAULT 0,
  Status NVARCHAR(32) NULL,
  RoundTeam_ID INT NOT NULL,
  RoundTeamPilot_ID INT NULL
);

CREATE TABLE Flights (
  ID INT NOT NULL PRIMARY KEY,
  PilotID INT NOT NULL,
  RoundID INT NOT NULL,
  DateTime DATETIME2 NULL,
  Distance DECIMAL(10,3) NOT NULL DEFAULT 0,
  url NVARCHAR(256) NULL,
  ScoringType NVARCHAR(16) NULL,
  isManualLog BIT NOT NULL DEFAULT 0,
  ManualLogJustification NVARCHAR(MAX) NULL,
  IsOverallPB BIT NOT NULL DEFAULT 0,
  AwardedOverallPB BIT NOT NULL DEFAULT 0,
  IsUKPersonalBest BIT NOT NULL DEFAULT 0,
  AwardedUKPersonalBest BIT NOT NULL DEFAULT 0,
  IsFirstXC BIT NOT NULL DEFAULT 0,
  AwardedFirstXC BIT NOT NULL DEFAULT 0,
  IsFirstUKXC BIT NOT NULL DEFAULT 0,
  AwardedFirstUKXC BIT NOT NULL DEFAULT 0,
  roundTeamPlace_ID INT NULL
);

CREATE TABLE RoundBriefs (
  ID INT NOT NULL PRIMARY KEY,
  RoundID INT NOT NULL,
  SiteName NVARCHAR(128) NULL,
  BrieferName NVARCHAR(128) NULL,
  BrieferBHPA_CoachLevel NVARCHAR(64) NULL,
  BrieferBHPA_Number NVARCHAR(32) NULL,
  BrieferPhoneNumber NVARCHAR(32) NULL,
  BrieferEmailAddress NVARCHAR(256) NULL,
  RoundDate DATETIME2 NULL,
  OrganisingClubName NVARCHAR(128) NULL,
  BriefingTime DATETIME2 NULL,
  LandByTime DATETIME2 NULL,
  CheckInByTime DATETIME2 NULL,
  NumTeamsInRound INT NULL,
  NumPilotsInRound INT NULL,
  WindSpeed_Direction NVARCHAR(64) NULL,
  DirectionOfFlight NVARCHAR(64) NULL,
  ExpectedLandingArea NVARCHAR(256) NULL,
  AirspaceAndHazards NVARCHAR(MAX) NULL,
  NOTAMs NVARCHAR(MAX) NULL,
  BENO_LineDescription NVARCHAR(MAX) NULL,
  BriefersNotes NVARCHAR(MAX) NULL,
  Image VARBINARY(MAX) NULL
);

CREATE TABLE RoundClubPilots (
  ID INT NOT NULL PRIMARY KEY,
  Pilot_ID INT NULL,
  Round_ID INT NULL,
  Club_ID INT NULL
);
