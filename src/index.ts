import { toPointsArray, clamp, lerp } from './utils'
import { StrokeOptions } from './types'
import * as vec from './vec'

export class FreehandSpline {
  looped: boolean
  points: number[][]
  lengths: number[]
  length: number

  size: number
  thinning: number
  smoothing: number
  streamline: number
  easing: (pressure: number) => number
  simulatePressure: boolean
  start: {
    taper: number
    easing: (distance: number) => number
  }
  end: {
    taper: number
    easing: (distance: number) => number
  }
  last: boolean

  constructor(
    points: (number[] | { x: number; y: number; pressure?: number })[],
    options = {} as StrokeOptions,
    looped = false
  ) {
    const {
      size = 8,
      thinning = 0.5,
      smoothing = 0.5,
      streamline = 0.5,
      simulatePressure = true,
      easing = t => t,
      start = {},
      end = {},
      last = false,
    } = options

    const {
      taper: taperStart = 0,
      easing: taperStartCurve = t => t * (2 - t),
    } = start

    const {
      taper: taperEnd = 0,
      easing: taperEndCurve = t => --t * t * t + 1,
    } = end

    this.size = size
    this.thinning = thinning
    this.smoothing = smoothing
    this.streamline = streamline
    this.simulatePressure = simulatePressure
    this.easing = easing
    this.start = { taper: taperStart, easing: taperStartCurve }
    this.end = { taper: taperEnd, easing: taperEndCurve }
    this.last = last

    let length: number
    let totalLength = 0
    let lengths: number[] = []

    const pts = toPointsArray(points)
    const len = pts.length

    // Apply streamline
    let [p0] = pts
    this.points = [p0]

    for (let i = 1; i < len; i++) {
      p0 = [...vec.lrp(p0, pts[i], 1 - streamline), pts[i][2]]
      this.points.push(p0)
    }

    // if (len > 3) {
    //   this.points.push(this.points[len - 2])
    // }

    // Calculate simulated presssures
    let pp = 0.5

    for (let i = 0; i < this.points.length - 1; i++) {
      length = vec.dist(this.points[i], this.points[i + 1])
      lengths.push(length)
      totalLength += length

      if (simulatePressure) {
        const rp = Math.min(1 - length / size, 1)
        const sp = Math.min(length / size, 1)
        this.points[i][2] = Math.min(1, pp + (rp - pp) * (sp / 2))
        pp = this.points[i][2]
      }
    }

    this.looped = looped
    this.lengths = lengths
    this.length = totalLength
  }

  getStrokeRadius(pressure = 0.5) {
    const { thinning, size, easing } = this
    if (!thinning) return size / 2
    pressure = clamp(easing(pressure), 0, 1)
    return (
      (thinning < 0
        ? lerp(size, size + size * clamp(thinning, -0.95, -0.05), pressure)
        : lerp(size - size * clamp(thinning, 0.05, 0.95), size, pressure)) / 2
    )
  }

  getPointsToDistance(distance: number) {
    const { points, lengths } = this

    const results: number[][] = []

    let i = 1
    let traveled = 0

    while (traveled < distance) {
      results.push(points[i])
      traveled += lengths[i]
      i++
    }
  }

  getOutlineShape() {
    const { lengths, size, smoothing, points } = this

    if (points.length < 2) {
      return points
    }

    const results: {
      point: number[]
      gradient: number[]
    }[] = []

    let error = 0
    let traveled = 0
    let point: number[]
    let gradient: number[]
    let short = true

    // Get evenly spaced points along the center spline
    for (let i = 0; i < points.length - 1; i++) {
      // distance to previous point
      const length = lengths[i]

      // distance traveled
      let trav = error

      while (trav <= length) {
        point = this.getSplinePoint(i + trav / length)
        gradient = vec.uni(this.getSplinePointGradient(i + trav / length))

        if (short && traveled + trav > size / 2) {
          for (let result of results) {
            result.gradient = gradient
          }
          short = false
        }

        results.push({ point, gradient })
        trav += size / 4
      }

      error = trav - length
      traveled += length
    }

    // For the last gradient, average the previous three points
    const lastGradient = results
      .slice(-3)
      .reduce(
        (acc, cur) => (acc ? vec.med(acc, cur.gradient) : cur.gradient),
        vec.uni(this.getSplinePointGradient(points.length - 1.1))
      )

    results.push({
      point: this.getSplinePoint(points.length - 1),
      gradient: lastGradient,
    })

    // results.push({ ...results[results.length - 1], isSharp: true })

    const leftSpline: number[][] = []
    const rightSpline: number[][] = []

    let l0: number[] | undefined
    let r0: number[] | undefined
    let tl: number[] | undefined
    let tr: number[] | undefined
    let tlu: number[] | undefined
    let plu: number[] | undefined
    let tru: number[] | undefined
    let pru: number[] | undefined
    let dpr = 0
    let ldpr = 1
    let rdpr = 1

    const minDist = size * smoothing

    for (let i = 0; i < results.length - 1; i++) {
      const { point, gradient } = results[i]

      // Sharp corners

      dpr = vec.dpr(gradient, results[i + 1].gradient)

      if (i > 0 && dpr < 0) {
        const { gradient: pg } = results[i - 1]

        const v = vec.mul(vec.per(pg), this.getStrokeRadius(point[2]))
        const l1 = vec.add(point, v)
        const r1 = vec.sub(point, v)

        if (l0) {
          plu = vec.uni(vec.vec(l0, l1))
        }

        if (r0) {
          plu = vec.uni(vec.vec(r0, r1))
        }

        for (let t = 0; t <= 1; t += 0.25) {
          const r = Math.PI * t
          tl = vec.rotAround(l1, point, r, r)
          tr = vec.rotAround(r1, point, -r, -r)
          leftSpline.push(tl)
          rightSpline.push(tr)
        }

        l0 = tl
        continue
      }

      // Regular points
      const r = vec.mul(vec.per(gradient), this.getStrokeRadius(point[2]))

      let addLeft = false
      let addRight = false

      tl = vec.add(point, r)
      tr = vec.sub(point, r)

      if (!l0 || i === results.length - 1) {
        addLeft = true
      } else {
        tlu = vec.uni(vec.vec(l0, tl))
        if (!plu) {
          plu = tlu
        } else {
          ldpr = vec.dpr(tlu, gradient)
          if (ldpr > 0 && vec.dist(l0, tl) > minDist) {
            addLeft = true
          }
        }
      }

      if (!r0 || i === results.length - 1) {
        addRight = true
      } else {
        tru = vec.uni(vec.vec(r0, tr))
        if (!pru) {
          pru = tru
        } else {
          rdpr = vec.dpr(tru, gradient)
          if (rdpr > 0 && vec.dist(r0, tr) > minDist) {
            addRight = true
          }
        }
      }

      if (addLeft) {
        leftSpline.push(tl)
        l0 = tl
        plu = tlu
      }

      if (addRight) {
        rightSpline.push(tr)
        r0 = tr
        pru = tru
      }
    }

    // Draw start cap
    const startCap: number[][] = []

    r0 = rightSpline[0]
    tl = results[0].point

    for (let t = 0; t <= 1; t += 0.25) {
      const r = Math.PI * t
      startCap.push(vec.rotAround(r0, tl, r, r))
    }

    // Draw end cap

    const endCap: number[][] = []

    // l0 = leftSpline[leftSpline.length - 1]
    // r0 = rightSpline[rightSpline.length - 1]

    // endCap.push(points[points.length - 1])

    // tl = this.getSplinePoint(points.length - 1)
    // l0 = vec.add(
    //   tl,
    //   vec.mul(
    //     vec.uni(vec.per(this.getSplinePointGradient(points.length - 1))),
    //     this.getStrokeRadius(tl[2])
    //   )
    // )
    // // const endCapDist = vec.dist(l0, r0)

    // for (let t = 0; t <= 1; t += 0.25) {
    //   const r = Math.PI * t
    //   endCap.push(vec.rotAround(l0, tl, r, r))
    // }

    // Reverse the right spline
    rightSpline.reverse()

    return [...startCap, ...leftSpline, ...endCap, ...rightSpline]
  }

  getSplinePoint(index: number): number[] {
    const { points, looped } = this

    let p0: number,
      p1: number,
      p2: number,
      p3: number,
      l = points.length,
      d = Math.trunc(index),
      t = index - d

    if (looped) {
      p1 = d
      p2 = (p1 + 1) % l
      p3 = (p2 + 1) % l
      p0 = p1 >= 1 ? p1 - 1 : l - 1
    } else {
      p1 = Math.min(d + 1, l - 1)
      p2 = Math.min(p1 + 1, l - 1)
      p3 = Math.min(p2 + 1, l - 1)
      p0 = p1 - 1
    }

    let tt = t * t,
      ttt = tt * t,
      q1 = -ttt + 2 * tt - t,
      q2 = 3 * ttt - 5 * tt + 2,
      q3 = -3 * ttt + 4 * tt + t,
      q4 = ttt - tt

    return [
      0.5 *
        (points[p0][0] * q1 +
          points[p1][0] * q2 +
          points[p2][0] * q3 +
          points[p3][0] * q4),
      0.5 *
        (points[p0][1] * q1 +
          points[p1][1] * q2 +
          points[p2][1] * q3 +
          points[p3][1] * q4),
      0.5 *
        (points[p0][2] * q1 +
          points[p1][2] * q2 +
          points[p2][2] * q3 +
          points[p3][2] * q4),
    ]
  }

  getSplinePointGradient(index: number): number[] {
    const { points, looped } = this

    let p0: number,
      p1: number,
      p2: number,
      p3: number,
      l = points.length,
      d = Math.trunc(index),
      t = index - d

    if (looped) {
      p1 = d
      p2 = (p1 + 1) % l
      p3 = (p2 + 1) % l
      p0 = p1 >= 1 ? p1 - 1 : l - 1
    } else {
      p1 = Math.min(d + 1, l - 1)
      p2 = Math.min(p1 + 1, l - 1)
      p3 = Math.min(p2 + 1, l - 1)
      p0 = p1 - 1
    }

    let tt = t * t,
      q1 = -3 * tt + 4 * t - 1,
      q2 = 9 * tt - 10 * t,
      q3 = -9 * tt + 8 * t + 1,
      q4 = 3 * tt - 2 * t

    return [
      0.5 *
        (points[p0][0] * q1 +
          points[p1][0] * q2 +
          points[p2][0] * q3 +
          points[p3][0] * q4),
      0.5 *
        (points[p0][1] * q1 +
          points[p1][1] * q2 +
          points[p2][1] * q3 +
          points[p3][1] * q4),
      0.5 *
        (points[p0][2] * q1 +
          points[p1][2] * q2 +
          points[p2][2] * q3 +
          points[p3][2] * q4),
    ]
  }

  calculateSegmentLength(segment: number) {
    let length = 0
    let stepSize = 1 / 200

    let oldPoint = this.getSplinePoint(segment)
    let newPoint: number[]

    for (let t = 0; t < 1; t += stepSize) {
      newPoint = this.getSplinePoint(segment + t)
      length += vec.dist(oldPoint, newPoint)
      oldPoint = newPoint
    }

    return length
  }

  getNormalizedOffsetAt(distance: number) {
    const { lengths } = this
    let i = 0
    while (distance > lengths[i]) {
      distance -= lengths[i]
      i++
    }

    return i + distance / lengths[i]
  }
}

/**
 * ## getStroke
 * @description Returns a stroke as an array of points.
 * @param points An array of points (as `[x, y, pressure]` or `{x, y, pressure}`). Pressure is optional.
 * @param options An (optional) object with options.
 * @param options.size	The base size (diameter) of the stroke.
 * @param options.thinning The effect of pressure on the stroke's size.
 * @param options.smoothing	How much to soften the stroke's edges.
 * @param options.streamline How much to streamline the stroke.
 * @param options.simulatePressure Whether to simulate pressure based on velocity.
 */
export default function getStroke<
  T extends number[],
  K extends { x: number; y: number; pressure?: number }
>(points: (T | K)[], options: StrokeOptions = {} as StrokeOptions): number[][] {
  const middleSpline = new FreehandSpline(points, options)
  return middleSpline.getOutlineShape()
}

export { StrokeOptions }
