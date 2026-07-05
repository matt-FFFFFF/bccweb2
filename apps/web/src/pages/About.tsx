import { Link } from "react-router";

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

export default function About() {
  return (
    <article style={pageStyle}>
      <h1 style={headingStyle}>About the British Club Challenge (BCC)</h1>
      
      <p>
        The Advance BCC is a UK Sport National Governing Body, in our case the British Hang Gliding and Paragliding Association (BHPA), endorsed event, designed to introduce lower airtime paragliding pilots to cross country competition flying and promote the development of the appropriate skill sets. This is achieved through a friendly, coaching environment, with pilots competing in low complexity tasks as members of small teams against other clubs. The primary aim of the BCC is pilot development through safe, supervised, and enjoyable flying.
      </p>

      <img src="/images/AdvanceLogo.jpg" alt="ADVANCE" style={{ maxWidth: 200, display: "block", margin: "1rem 0" }} />

      <p>
        The BCC is very proud to be sponsored by ADVANCE, who excel at putting ideas into the air. For more than 30 years ADVANCE have kept the needs and wishes of their pilots at the forefront. With Swiss precision they refine model after model. Highest quality and absolute reliability are their top priority, in the air and in customer service. ADVANCE are fully supportive of the ethos and spirit of the BCC, which is why they in turn are pleased to be associated with our event.
      </p>

      <hr style={{ margin: "2rem 0", border: "0", borderTop: "1px solid #e5e7eb" }} />

      <p>
        <strong>Key information.</strong> The following key information is provided, in a single, easily accessible location (including from your phone), to facilitate the key goals of the BCC, which are to fly safely, have fun and learn.
      </p>

      <p>
        <Link to="/terms">Terms and Conditions.</Link> These are the terms and conditions, including the GDPR statement for this system, that all clubs and pilots agree to when registering to take part in the BCC.
      </p>

      <p>
        <a href="https://www.facebook.com/groups/370534829753625" target="_blank" rel="noopener noreferrer">BCC Facebook Group.</a> The BCC's Facebook Group is a private group for the use of all BHPA Flying Members taking part in the BCC. It can be used to post information on forthcoming rounds and upload reports and pictures from completed events. Please note that all potential members will need to be approved by BCC Admin.
      </p>

      <p>
        <a href="https://www.facebook.com/advancebcc" target="_blank" rel="noopener noreferrer">BCC Facebook Page.</a> The BCC has a public facing Facebook Page which anyone can view and in which we like to publish stories relating to our many BCC adventures. We welcome articles from all our competitors, of any experience level, which are also submitted for publication in Skywings, the BHPA's monthly magazine.
      </p>

      <p>
        <strong>Previous BCC System.</strong> The legacy BCC system can still be accessed via <a href="https://www.flybcc.co.uk" target="_blank" rel="noopener noreferrer">https://www.flybcc.co.uk</a>. There you will find all the BCC results from season 2006, to season 2021.
      </p>

      <p>
        <strong>Other Key Information.</strong> From the BCC &gt; Key Information link, you will also have access to the following important documents, which are summarised as follows:
      </p>

      <ul>
        <li>
          <a href="/static/BCCRulesUpdateApril2025.pdf" target="_blank" rel="noopener noreferrer"><strong>BCC Rules</strong></a> This is a key document; all pilots are required to have read and understood the rules of the BCC prior to taking part in any rounds.
        </li>
        <li>
          <a href="/static/AdvanceBCCBriefingAideMemoireApr2025.pdf" target="_blank" rel="noopener noreferrer"><strong>BCC Briefing Aide Memoire</strong></a> The aide memoire is a handrail document, designed to assist Round Coords who are organising or hosting a round, in delivering a suitable pre-round brief to team captains and pilots.
        </li>
        <li>
          <a href="/static/bcccovidra_04_2022.pdf" target="_blank" rel="noopener noreferrer"><strong>BCC COVID-19 Risk Assessment</strong></a> The assessment was conducted in May 2021 and will be reviewed prior to the start of each season. Should COVID-19 or other communicable disease mitigation measures be introduced at any time throughout a BCC season, the mitigations detailed in this document should be reviewed again and then enacted as required.
        </li>
        <li>
          <a href="/static/ParaglidingSOPsv1.7.pdf" target="_blank" rel="noopener noreferrer"><strong>Paragliding Standard Operating Procedures (SOPs)</strong></a> These 'Flight Reference Card' style SOPs are an aide memoire for many aspects of our sport, from pre-flight planning and preparations, to dealing with in flight emergencies and 'actions on' following an incident or accident. Although an excellent resource, they must be read with the following caveats:
          <ul>
            <li>The SOPs are designed as an aide-memoire only.</li>
            <li>Each pilot must use their own captaincy, airmanship, training, and judgement to maintain their safety and that of others around them.</li>
            <li>Use of the SOPs in no way absolves a pilot from their responsibilities, nor infers any liability on the author.</li>
          </ul>
        </li>
      </ul>

      <p>
        <strong>Contacting the BCC.</strong> Please direct any questions that you may have on any aspect of the BCC to the BCC Coordinator, Matthew Tandy, via <a href="mailto:coord@advance-bcc.uk">coord@advance-bcc.uk</a>.
      </p>
    </article>
  );
}
