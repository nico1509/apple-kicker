# Apple Kicker

<p align="center"><img src="docs/logo.png" alt="Apple Kicker Logo" width="480"></p>

Ein kleines 3D-Browserspiel: Du stehst auf einem prozedural generierten Feldweg
im goldenen Oktober und kickst deinen Apfel so weit wie möglich den Weg entlang –
während dich von hinten eine Gewitterfront einholt.

*A small 3D browser game: kick your apple down an endless, procedurally generated
autumn country lane before the thunderstorm behind you catches up.*

## Spielen

Du brauchst nur Node.js (≥ 20.19 bzw. ≥ 22.12) und einen Browser mit WebGL.

```bash
npm install
npm run dev
```

Dann die angezeigte Adresse (normalerweise <http://localhost:5173>) im Browser öffnen
und auf **Klicken zum Starten** drücken. Der Mauszeiger wird eingefangen (Pointer Lock),
`Esc` oder `P` pausiert.

Auf schwachen Rechnern `?quality=low` oder `?quality=medium` an die Adresse hängen
(weniger bzw. keine Schatten, kein Antialiasing).

### Steuerung

| Eingabe | Aktion |
| --- | --- |
| `W` `A` `S` `D` | laufen |
| `Shift` | sprinten (begrenzte Ausdauer) |
| Maus | umsehen |
| **Linke Maustaste** halten, ziehen, loslassen | Kick mit dem **linken** Fuß |
| **Rechte Maustaste** halten, ziehen, loslassen | Kick mit dem **rechten** Fuß |
| kurzer Klick | kleiner Stupser nach vorn |
| `Leertaste` beim Loslassen halten | hoher Lupfer (über Wurzeln und Baumstämme) |
| `Q` / `E` | Stupser mit dem linken / rechten Fuß |
| `M` | Ton an/aus |
| `P` / `Esc` | Pause (im Pausenmenü: `R` = Neustart) |

Die **Zugrichtung** bestimmt die Schussrichtung (nach oben ziehen = geradeaus),
die **Zuglänge** die Kraft. Der Apfel muss dicht vor dem jeweiligen Fuß liegen –
der linke Fuß erreicht Äpfel links von der Mitte, der rechte rechts. Jeder Fuß gibt
dem Apfel außerdem einen leichten Drall nach innen (linker Fuß: nach rechts, rechter Fuß: nach links).

### Regeln

* Gezählt werden die Meter, die der **Apfel** entlang des Weges zurücklegt.
* Hinter dir zieht eine Schlechtwetterfront mit Regen und Gewitter heran. Sie wird
  mit der Zeit schneller. Holt sie **dich oder deinen Apfel** ein, ist der Lauf vorbei.
* Ist der Apfel mehr als 50 m von dir entfernt, wird er immer markiert, auch wenn
  er im Bild ist.
* Mit der Strecke tauchen immer mehr Hindernisse auf: Wurzeln, Äste, Steine,
  Pfützen, umgestürzte Stämme und Hügel. Kick fester, lupf drüber oder such dir
  einen Weg drum herum.
* Auf den Fahrspuren rollt der Apfel am besten, auf Wiese und Acker bremst er schneller.
* Der Rekord wird im Browser (localStorage) gespeichert.

## Technik

* [three.js](https://threejs.org/) für die 3D-Darstellung, [Vite](https://vite.dev/) + TypeScript für den Build.
* Alles ist prozedural: Die Welt entsteht aus einem Seed (Höhenfeld, Wegverlauf,
  Biome wie Wald, Wiese, Hecke, Acker und Weinberg, Bäume, Hindernisse). Es werden keine
  externen Assets geladen – auch die Geräusche werden mit der Web Audio API synthetisiert.
* Die Physik des Apfels ist eine eigene kleine Kugel-gegen-Höhenfeld-Simulation mit
  Kapsel-, Kugel- und Zylinder-Kollidern für Wurzeln, Stämme, Steine und Bäume.
* Flat-Shading und wenige Polygone sorgen für den stilisierten Low-Poly-Look.

### Scripts

```bash
npm run dev        # Entwicklungsserver
npm run build      # Typprüfung + Produktions-Build nach dist/
npm run preview    # Produktions-Build lokal ansehen
npm run smoke      # Headless-Test mit Chromium (CHROME_PATH auf ein Chrome/Chromium zeigen lassen)
```

Der Produktions-Build in `dist/` ist rein statisch und läuft von jedem Webserver
(auch aus einem Unterverzeichnis, z. B. GitHub Pages).

### Stimmung

Die Optik orientiert sich an deutschen Feldwegen im Oktober: Fahrspuren mit
Grasstreifen, Hecken und Streuobstwiesen, frisch gepflügte Äcker, Weinberge am Hang
und bewaldete Hügel am Horizont unter Schleierwolken.

### Logo

Das Logo nutzt die Schrift [Luckiest Guy](https://fonts.google.com/specimen/Luckiest+Guy)
von Astigmatic (Apache License 2.0), lokal eingebunden unter `public/fonts/`.
Der Apfel aus dem Logo ist zugleich das Favicon (`public/favicon.svg`).
