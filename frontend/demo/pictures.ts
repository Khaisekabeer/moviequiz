// Drawings for the picture questions, by question index in the recording. The real game shows stills
// the quiz master uploads; these are made for the demo, so no film stills ship in the file.
const svg = (body: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800">${body}</svg>`)}`

const stars = (n: number, height: number) => Array.from({ length: n }, (_, i) =>
  `<circle cx="${(i * 197) % 1200}" cy="${(i * 113) % height}" r="${1.4 + (i % 3)}" fill="#fff" opacity="${0.4 + (i % 4) * 0.15}"/>`).join('')

const titanic = svg(`
  <defs><linearGradient id="n" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#060b24"/><stop offset="1" stop-color="#1b3a6b"/></linearGradient></defs>
  <rect width="1200" height="800" fill="url(#n)"/>${stars(70, 460)}
  <path d="M760 560 L840 300 L900 370 L950 210 L1040 340 L1090 300 L1180 560Z" fill="#dff3ff"/>
  <path d="M840 300 L900 370 L880 560 L760 560Z M950 210 L1040 340 L1000 560 L920 560Z" fill="#a9d6ee"/>
  <g transform="rotate(-2 400 500)">
    <path d="M70 470 L700 470 L650 590 L130 590Z" fill="#0c0f1c"/>
    <rect x="130" y="420" width="520" height="52" fill="#f3efe3"/>
    <rect x="170" y="382" width="430" height="40" fill="#e6dfca"/>
    ${[210, 310, 410, 510].map(x => `<path d="M${x} 382 L${x + 12} 280 L${x + 66} 280 L${x + 66} 382Z" fill="#d9822b"/><rect x="${x + 12}" y="280" width="54" height="24" fill="#16182a"/>`).join('')}
    ${Array.from({ length: 22 }, (_, i) => `<rect x="${146 + i * 22}" y="436" width="10" height="10" fill="#ffd166"/>`).join('')}
    <path d="M84 470 L640 470" stroke="#d62828" stroke-width="6"/>
  </g>
  <path d="M0 570 Q150 545 300 570 T600 570 T900 570 T1200 570 V800 H0Z" fill="#0f2a55"/>
  <path d="M0 640 Q150 615 300 640 T600 640 T900 640 T1200 640 V800 H0Z" fill="#0a1f42"/>
`)

const fin = svg(`
  <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb347"/><stop offset="1" stop-color="#ff6f61"/></linearGradient></defs>
  <rect width="1200" height="800" fill="url(#s)"/>
  <circle cx="930" cy="240" r="120" fill="#ffe29a"/>
  <rect y="420" width="1200" height="380" fill="#10557c"/>
  <path d="M0 460 Q100 440 200 460 T400 460 T600 460 T800 460 T1000 460 T1200 460 V800 H0Z" fill="#0e4a6e"/>
  <path d="M420 590 C470 430 590 300 720 250 C690 350 700 490 780 590Z" fill="#2f3a45"/>
  <path d="M520 590 C560 480 620 390 700 320 C680 400 690 500 740 590Z" fill="#3f4e5c"/>
  <path d="M250 610 Q420 570 590 610 T930 610 T1100 600" stroke="#fff" stroke-width="14" fill="none" stroke-linecap="round" opacity=".75"/>
  <path d="M150 670 Q330 635 520 670 T900 670" stroke="#fff" stroke-width="10" fill="none" stroke-linecap="round" opacity=".4"/>
`)

const moon = svg(`
  <rect width="1200" height="800" fill="#0a1a3f"/>${stars(90, 700)}
  <circle cx="660" cy="350" r="290" fill="#fff4cf"/>
  <circle cx="570" cy="280" r="46" fill="#f2e3b0"/><circle cx="760" cy="430" r="62" fill="#f2e3b0"/><circle cx="780" cy="230" r="30" fill="#f2e3b0"/>
  <g transform="translate(610 340) rotate(-8)" stroke="#0a1a3f" stroke-width="12" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="-120" cy="70" r="62"/><circle cx="130" cy="70" r="62"/>
    <path d="M-120 70 L-40 -30 L80 -30 L10 70 Z M80 -30 L130 70 M70 -62 L84 -30 M50 -66 L92 -60 M-52 -46 L-22 -46"/>
    <path d="M-40 -46 L-16 -120 L34 -68 L10 70" stroke-width="20"/>
    <rect x="62" y="-112" width="74" height="48" rx="8" fill="#0a1a3f"/>
    <circle cx="-8" cy="-146" r="24" fill="#0a1a3f"/>
    <circle cx="100" cy="-128" r="17" fill="#0a1a3f"/>
  </g>
  <path d="M0 800 V700 L60 620 L120 700 L180 600 L260 710 L340 640 L420 720 L520 660 L640 730 L760 650 L860 720 L960 610 L1040 700 L1120 630 L1200 710 V800Z" fill="#050d24"/>
`)

export const PICTURES: Record<number, string> = { 5: titanic, 6: fin, 10: moon }
