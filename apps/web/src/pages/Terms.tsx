import { TS_CS_VERSION } from "../lib/terms.js";

const pageStyle: React.CSSProperties = {
  maxWidth: 760,
  margin: "3rem auto",
  lineHeight: 1.6,
  color: "#1f2937",
};

const headingStyle: React.CSSProperties = {
  fontSize: "2rem",
  marginBottom: "1rem",
};

export default function Terms() {
  return (
    <article style={pageStyle}>
      <h1 style={headingStyle}>Terms &amp; Conditions</h1>
      <p>
        By registering to participate in the Advance British Club Challenge (BCC), all pilots are confirming that they are eligible to compete,
        agree to abide by its rules, the British Paragliding Competitions Terms and Conditions and that they accept the General Data Protection
        Regulation (GDPR) Statement below:
      </p>

      <ol>
        <li>
          <strong>British Club Challenge Terms and Conditions</strong>
          <ol>
            <li>
              <strong>General.</strong> The BCC is wholly subordinated to British Paragliding Competitions, which is an empowered organisation within the British Hang Gliding and Paragliding Association. Participation in the BCC is subject to adherence to the British Paragliding Competitions endorsed BCC Rules, of which the following are emphasised as being key principles for any event.
            </li>
            <li>
              <strong>Safe flying.</strong> All pilots fly under their own responsibility. It is each pilot’s obligation to take all necessary actions to maintain their own safety whilst competing, and to ensure that they do not act in any way that might endanger any other pilots. It is a condition of entry to British Paragliding Competitions for all pilots to accept, without restriction, to hold the Organisers and British Competitions Panel blameless, and waive all claims to compensation.
            </li>
            <li>
              <strong>Sportsmanship.</strong> The purpose of British Paragliding Competitions is to provide a sporting, fair, competitive and safe contest, in order to determine event winners and to reinforce friendship amongst all British Club Challenge competitors.
            </li>
            <li>
              <strong>Communicable Disease Mitigation.</strong> In addition to the responsibility of all pilots to fly safely, all participants and supporters of British Paragliding Competitions are required to adhere to the necessary precautions that mitigate the risk of transmission of communicable diseases. This includes the currently in force measures to protect against the spread of COVID-19, noting that these mitigations may change at relatively short notice and differ between the Home Nations of the United Kingdom.
            </li>
            <li>
              <strong>Pilot Eligibility.</strong> All pilots wishing to participate in the BCC must meet the following requirements:
              <ul>
                <li>They must be Flying Members of the BHPA to ensure that they are provided with the appropriate third party insurance. Team captains are responsible for ensuring that this key requirement is complied with.</li>
                <li>Pilots should be full members of the BHPA recognised club that they compete for. Once a pilot has flown a BCC round for a club they may not fly for another club in the same season.</li>
                <li>The competition is open to all pilots of sufficient experience and competence to safely fly with others, undertake thermal flying and attempt cross country flying.</li>
                <li>It is <strong><em>recommended</em></strong> that competitors have a minimum of <strong>Club Pilot plus 15 hours</strong> airtime, but team captains may use their discretion when selecting team members.</li>
              </ul>
            </li>
          </ol>
        </li>
        <li>
          <strong>British Club Challenge Global Data Protection Regulations Statement</strong>
          <ol>
            <li>
              <strong>Personal Data.</strong> The BCC system stores the following personally identifiable or sensitive information about the users:
              <ul>
                <li>Name</li>
                <li>Email address</li>
                <li>Phone Number</li>
                <li>Emergency contact's name</li>
                <li>Emergency contact's phone number</li>
                <li>Medical conditions</li>
              </ul>
            </li>
            <li>
              <strong>Information Management.</strong> This information is not viewable by users that are not registered with the system. It is stored on a secure database, hosted in Microsoft Azure. This information can, by design, be seen by users in the following roles:
              <ul>
                <li>System Administrators</li>
                <li>BCC Rounds Coordinator for the club with which you are flying in the current season</li>
                <li>Captain of the team in which you fly a round</li>
                <li>BCC Rounds Coordinator for the club hosting any round in which you are registered</li>
                <li>All members of the team in which you are registered, both scoring and non-scoring</li>
              </ul>
            </li>
            <li>
              <strong>Information Usage</strong>
            </li>
          </ol>
          <p>
            The BCC will use the information you have provided for the purposes of safely administering the event. The data you provide will be stored on our servers within the UK and kept by us while you are competing in the BCC and for a period of 6 years afterwards. The BCC will not share your data with third parties other than to safely administer the event (eg BHPA Registered Clubs, insurers, FAI etc, and in the pursuit of flight safety the AAIB, UK Airprox Board etc) without your prior permission.
          </p>
          <p>
            You have the right to object to our use of your data, withdraw your consent for us to use your data, request a copy of the data we hold, require us to correct any errors in that data and to require us to delete your personal data. You can do this by contacting the BCC Coordinator at coord@advance-bcc.uk Please note that if you choose to withdraw your consent you will no longer be able to participate in the BCC.
          </p>
        </li>
      </ol>

      <footer style={{ marginTop: "2rem", fontSize: "0.9rem", color: "#6b7280" }}>Terms version: {TS_CS_VERSION}</footer>
    </article>
  );
}
