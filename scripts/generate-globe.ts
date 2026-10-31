/**
 * Rasterizes Natural Earth's 110m land (public domain, via the world-atlas
 * package) into the evenly spaced dots the homepage's globe is drawn from.
 *
 *   bun scripts/generate-globe.ts path/to/land-110m.json
 *
 * Dots sit on rings of constant latitude with a count proportional to
 * cos(latitude), so they are about the same distance apart everywhere on the
 * sphere. Only land is kept; the page does the projection, so the data does not
 * depend on which side of the planet it shows.
 */
import { writeFileSync } from 'node:fs'

const source = process.argv[2]
if (!source)
  throw new Error('Usage: bun scripts/generate-globe.ts path/to/land-110m.json')

interface Topology {
  transform: { scale: [number, number], translate: [number, number] }
  arcs: number[][][]
  objects: { land: { geometries: Array<{ type: string, arcs: number[][][][] | number[][][] }> } }
}

const topo = JSON.parse(await Bun.file(source).text()) as Topology
const { scale, translate } = topo.transform

const arcs = topo.arcs.map((arc) => {
  let x = 0
  let y = 0
  return arc.map(([dx, dy]) => {
    x += dx!
    y += dy!
    return [x * scale[0] + translate[0], y * scale[1] + translate[1]] as [number, number]
  })
})

function ring(indexes: number[]): Array<[number, number]> {
  const points: Array<[number, number]> = []
  for (const index of indexes) {
    const arc = index >= 0 ? arcs[index]! : [...arcs[~index]!].reverse()
    points.push(...(points.length ? arc.slice(1) : arc))
  }
  return points
}

// Each polygon: an outer ring, then holes. Even-odd over all of them.
const polygons: Array<Array<Array<[number, number]>>> = []
for (const geometry of topo.objects.land.geometries) {
  const list = (geometry.type === 'Polygon' ? [geometry.arcs] : geometry.arcs) as number[][][][]
  for (const polygon of list)
    polygons.push(polygon.map(ring))
}

function inside(lon: number, lat: number): boolean {
  let hit = false
  for (const polygon of polygons) {
    for (const points of polygon) {
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i]!
        const [xj, yj] = points[j]!
        if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
          hit = !hit
      }
    }
  }
  return hit
}

const STEP = 1.7 // degrees of latitude between rings
const rows: Array<{ lat: number, lons: number[] }> = []
for (let lat = -58; lat <= 84; lat += STEP) {
  const count = Math.max(1, Math.round(360 * Math.cos((lat * Math.PI) / 180) / STEP))
  const lons: number[] = []
  for (let i = 0; i < count; i++) {
    // Rings are offset from each other so the dots do not line up in columns.
    const lon = -180 + ((i + (rows.length % 2) * 0.5) * 360) / count
    if (inside(lon, lat))
      lons.push(Math.round(lon * 10) / 10)
  }
  if (lons.length)
    rows.push({ lat: Math.round(lat * 10) / 10, lons })
}

writeFileSync(new URL('../resources/data/land.json', import.meta.url), `${JSON.stringify({ step: STEP, rows })}\n`)
console.log(`${rows.reduce((n, r) => n + r.lons.length, 0)} land dots in ${rows.length} rings`)
