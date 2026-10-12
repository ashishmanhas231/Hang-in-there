using System;
using System.Collections.Generic;
using System.Windows;

namespace SpideyHang;

internal sealed class Particle
{
    public double X;
    public double Y;
    public double PX;
    public double PY;

    /// <summary>Inverse mass. 0 = pinned in place. Smaller = heavier.</summary>
    public double W;

    public Particle(double x, double y, double w)
    {
        X = PX = x;
        Y = PY = y;
        W = w;
    }
}

/// <summary>
/// The web rope and the body.
///
/// Verlet integration: each particle stores where it is now and where it was one step ago.
/// The gap between the two is its velocity. To push something, move its previous position.
///
/// The last rope particle is his ankle. A separate head particle is joined to it by a stiff link,
/// so he swings like a double pendulum. All coordinates are window-local, in WPF units.
/// </summary>
internal sealed class Rig
{
    public const double Step = 1.0 / 240;

    // Rounds of length-fixing per step. The light rope (see WRope) needs many: with 24, a hard
    // fling stretched it 25% and he flew over the top. Cheap next to drawing a frame.
    private const int Iterations = 64;
    private const double Gravity = 1800;
    private const double Damping = 0.9984;

    // When the body is slower than SettleSpeed (units per second), friction gets much stronger.
    // Without it, the last few pixels of swing take close to a minute to die out, and the
    // overlay keeps drawing that whole time. With it he settles in about 2 seconds.
    private const double SettleSpeed = 90;
    private const double SettleDamping = 0.992;

    /// <summary>How far below the head particle the figure reaches (hands, or the bottom of a picture), as a share of body length.</summary>
    public const double ReachPastHead = 0.32;

    // "Swing on his own" works like pumping a playground swing: a push in the direction he is
    // already moving, sized by how far his last swing fell short of SwingTarget.
    // That keeps the swing steady. A plain push every time would make it grow until he hits the walls.
    private const double SwingTarget = 0.55;   // radians from straight down, about 31 degrees
    private const double PumpStrength = 900;   // units per second squared, at full speed and full shortfall

    // Grip between rope and body. With the light rope these barely matter in a normal swing
    // (his body stays within 2 degrees of the rope); they still calm him after a hard fling.
    private const double GripDampShare = 0.006;
    private const double GripStiffness = 0.04;

    private double lastPeak;
    private int lastDirection;

    /// <summary>True if anything touched a window edge or the top in the last step.</summary>
    private bool touching;

    /// <summary>
    /// The part of the window that is on screen, in window units. The window may run past a
    /// screen edge, so "Swing on his own" keeps his swing inside these, not the window's own edges.
    /// </summary>
    public double VisibleLeft { get; set; }
    public double VisibleRight { get; set; } = double.MaxValue;

    /// <summary>How far the rope leans from straight down, in radians. For the test log.</summary>
    public double RopeAngle => Math.Atan2(Ankle.X - Anchor.X, Ankle.Y - Anchor.Y);

    /// <summary>How far his body leans from straight down, in radians. For the test log.</summary>
    public double BodyAngle => Math.Atan2(Head.X - Ankle.X, Head.Y - Ankle.Y);

    /// <summary>Actual rope length divided by its proper length. 1.00 means no stretch. For the test log.</summary>
    public double RopeStretch
    {
        get
        {
            double actual = 0, proper = 0;
            for (int i = 0; i < RopeCount - 1; i++)
            {
                var (a, b, length) = links[i];
                actual += Math.Sqrt((b.X - a.X) * (b.X - a.X) + (b.Y - a.Y) * (b.Y - a.Y));
                proper += length;
            }
            return proper > 0 ? actual / proper : 1;
        }
    }
    // Top speed of any point, units per second. A swing reaches horizontal at about
    // sqrt(2 x gravity x length) = 1,250 for a medium Spidey, so 1,300 still allows a full swing.
    // Above that a hard fling sent him over the top, where the rope goes slack and snaps (it was 2,600).
    private const double MaxSpeed = 1300;
    private const double BreezeStrength = 140;
    // Leaves room above the anchor for the web splat that sticks him to the top of the screen.
    private const double AnchorY = 10;

    // A light rope, as a real web line is next to the person on it.
    //
    // With a heavy rope (2, the old value) the rope outweighed him two to one. Its lower end then
    // whipped, his body followed the whip, and the swing visibly hitched: fast, slow at the bottom,
    // fast again (two speed peaks per half-swing instead of one).
    // Much lighter than 10 and the solver cannot hold the rope's length under his weight, so it
    // stretches and he bounces. At 10 the length varies by under 0.5% during a swing.
    private const double WRope = 10;
    private const double WAnkle = 0.6;
    private const double WHead = 0.4;

    private readonly List<Particle> particles = new();
    private readonly List<(Particle A, Particle B, double Length)> links = new();

    public IReadOnlyList<Particle> Particles => particles;
    public Particle Anchor { get; private set; } = new(0, 0, 0);
    public Particle Ankle { get; private set; } = new(0, 0, 0);
    public Particle Head { get; private set; } = new(0, 0, 0);

    /// <summary>Particles in the rope, counting the anchor and the ankle.</summary>
    public int RopeCount { get; private set; }

    public double BodyLength { get; private set; }

    /// <summary>The rope's proper length, anchor to ankle.</summary>
    public double RopeLength => links.Count > 1 ? (RopeCount - 1) * links[0].Length : 0;

    private double width;
    private double height;

    /// <summary>Builds a fresh rope and body, hanging straight down from anchorX.</summary>
    public void Build(double width, double height, double anchorX, double ropeLength, double bodyLength)
    {
        particles.Clear();
        links.Clear();
        this.width = width;
        this.height = height;
        BodyLength = bodyLength;

        int segments = Math.Clamp((int)Math.Round(ropeLength / 16), 8, 28);
        double segLength = ropeLength / segments;

        for (int i = 0; i <= segments; i++)
        {
            double w = i == 0 ? 0 : i == segments ? WAnkle : WRope;
            particles.Add(new Particle(anchorX, AnchorY + i * segLength, w));
        }
        Anchor = particles[0];
        Ankle = particles[segments];
        RopeCount = particles.Count;

        Head = new Particle(anchorX, Ankle.Y + bodyLength, WHead);
        particles.Add(Head);

        for (int i = 0; i < segments; i++)
        {
            links.Add((particles[i], particles[i + 1], segLength));
        }
        links.Add((Ankle, Head, bodyLength));
    }

    /// <summary>A sideways shove. Strength 1 is a clear swing. direction is -1, +1, or 0 for random.</summary>
    public void Kick(double strength, int direction = 0)
    {
        int dir = direction != 0 ? Math.Sign(direction) : (Random.Shared.Next(2) == 0 ? -1 : 1);
        for (int i = 1; i < particles.Count; i++)
        {
            double along = i >= RopeCount ? 1 : (double)i / (RopeCount - 1);
            particles[i].PX -= dir * strength * 520 * along * Step;
        }
    }

    /// <summary>Adds sideways speed (units per second) to one particle.</summary>
    public static void Nudge(Particle p, double speedX)
    {
        p.PX -= speedX * Step;
    }

    /// <summary>Moves everything except the anchor. Used when the window moves, so he stays put on screen.</summary>
    public void ShiftAll(double dx)
    {
        for (int i = 1; i < particles.Count; i++)
        {
            particles[i].X += dx;
            particles[i].PX += dx;
        }
    }

    public void MoveAnchor(double x)
    {
        Anchor.X = Anchor.PX = x;
    }

    public void Simulate(double time, bool breeze, bool autoSwing, Particle? dragged, Point target)
    {
        double wind = breeze
            ? BreezeStrength * (0.6 * Math.Sin(time * 0.8) + 0.4 * Math.Sin(time * 1.9 + 1.3))
            : 0;
        double pump = autoSwing && dragged == null ? PumpAcceleration() : 0;
        double maxMove = MaxSpeed * Step;
        double bodySpeed = Math.Max(StepDistance(Ankle), StepDistance(Head)) / Step;

        // No settling friction while he swings on his own: it would brake him at every turn.
        double damping = dragged == null && !autoSwing && bodySpeed < SettleSpeed ? SettleDamping : Damping;

        for (int i = 0; i < particles.Count; i++)
        {
            var p = particles[i];
            if (p.W == 0)
            {
                continue;
            }
            // The pump turns the whole thing as one long pendulum: each point gets a push in
            // proportion to its distance from the anchor. Pushing only his body would spin him
            // round his grip instead, and he would end up flat in the air.
            double push = pump * DistanceShare(i);
            double vx = (p.X - p.PX) * damping;
            double vy = (p.Y - p.PY) * damping;

            double speed = Math.Sqrt(vx * vx + vy * vy);
            if (speed > maxMove)
            {
                vx *= maxMove / speed;
                vy *= maxMove / speed;
            }

            p.PX = p.X;
            p.PY = p.Y;
            p.X += vx + (wind + push) * Step * Step;
            p.Y += vy + Gravity * Step * Step;
        }

        // The grip only makes sense when he is roughly in line with the rope. Leave it off:
        //   - against a window edge or the top, where the rope can fold back past his hand and the grip
        //     would pull his body along the folded rope and flip him over;
        //   - when he is tangled (body more than about 57 degrees off the rope end), where lining him up
        //     with a wildly spinning rope end only feeds the spin.
        if (!touching && BodyOffRopeEnd() < 1.0)
        {
            DampGrip();
            StraightenGrip();
        }

        if (dragged != null)
        {
            dragged.X += (target.X - dragged.X) * 0.3;
            dragged.Y += (target.Y - dragged.Y) * 0.3;
        }

        for (int i = 0; i < Iterations; i++)
        {
            foreach (var (a, b, length) in links)
            {
                Solve(a, b, length);
            }
        }
        Contain();
    }

    /// <summary>
    /// How far a particle is from the anchor, as a share of the anchor-to-ankle distance.
    /// 0 at the anchor, 1 at the ankle (his grip), more than 1 at his head.
    /// </summary>
    private double DistanceShare(int i)
    {
        double rope = Math.Max(1, (RopeCount - 1) * links[0].Length);
        return i < RopeCount ? (double)i / (RopeCount - 1) : 1 + BodyLength / rope;
    }

    /// <summary>
    /// A little stiffness where the rope meets him, so he follows the swing with a slight lag
    /// instead of spinning freely round his grip. Takes about 0.6% of the extra turning speed each
    /// step, so a wobble dies out in under a second.
    ///
    /// Only damps how fast his body turns COMPARED WITH the last bit of rope. Damping his turning
    /// speed on its own would also fight the normal swing: his body would try to stay upright in
    /// space while the rope swung round him (measured: up to 25 degrees off the rope).
    /// </summary>
    private void DampGrip()
    {
        double share = GripDampShare;
        var ropeEnd = particles[RopeCount - 2];

        double bodyTurn = TurnSpeed(Ankle, Head);
        double ropeTurn = TurnSpeed(ropeEnd, Ankle);
        double extra = bodyTurn - ropeTurn;

        // Turning at speed w moves the head at w * (-sy, sx). Remove a share of the extra part.
        // Verlet: raising the previous position lowers the speed.
        double sx = Head.X - Ankle.X;
        double sy = Head.Y - Ankle.Y;
        Head.PX += share * extra * -sy;
        Head.PY += share * extra * sx;
    }

    /// <summary>
    /// Pulls his body a little way back into line with the end of the rope each step, like an arm
    /// (or ankles) holding the body roughly in line with what it hangs from.
    ///
    /// Without it, the rope is so much heavier than him in this model that it whips like a chain,
    /// and his body swung about twice as far as the rope (measured: 32 degrees off the rope in a
    /// 34 degree swing). He can still bend away from the line when flung, then he comes back.
    /// </summary>
    private void StraightenGrip()
    {
        double stiffness = GripStiffness;
        var ropeEnd = particles[RopeCount - 2];
        double rx = Ankle.X - ropeEnd.X;
        double ry = Ankle.Y - ropeEnd.Y;
        double len = Math.Sqrt(rx * rx + ry * ry);
        if (len < 1e-6)
        {
            return;
        }
        double targetX = Ankle.X + rx / len * BodyLength;
        double targetY = Ankle.Y + ry / len * BodyLength;
        double dx = (targetX - Head.X) * stiffness;
        double dy = (targetY - Head.Y) * stiffness;

        // Move the previous position too, so this shifts him without adding speed.
        // Moving only X and Y is a push in this kind of physics: it fed energy into tangles and
        // kept him spinning for 30+ seconds after a hard fling.
        Head.X += dx;
        Head.Y += dy;
        Head.PX += dx;
        Head.PY += dy;
    }

    /// <summary>Angle in radians between his body and the last bit of rope. 0 = in line.</summary>
    private double BodyOffRopeEnd()
    {
        var ropeEnd = particles[RopeCount - 2];
        double a1 = Math.Atan2(Ankle.X - ropeEnd.X, Ankle.Y - ropeEnd.Y);
        double a2 = Math.Atan2(Head.X - Ankle.X, Head.Y - Ankle.Y);
        return Math.Abs(Math.IEEERemainder(a2 - a1, 2 * Math.PI));
    }

    /// <summary>How fast the line from a to b is turning, in radians per step (positive = clockwise on screen).</summary>
    private static double TurnSpeed(Particle a, Particle b)
    {
        double sx = b.X - a.X;
        double sy = b.Y - a.Y;
        double lenSq = sx * sx + sy * sy;
        if (lenSq < 1e-9)
        {
            return 0;
        }
        double vx = (b.X - b.PX) - (a.X - a.PX);
        double vy = (b.Y - b.PY) - (a.Y - a.PY);
        return (sx * vy - sy * vx) / lenSq;
    }

    /// <summary>
    /// The sideways push for this step: along his motion while the last swing was too small, else none.
    ///
    /// The target is capped by the room on each side. Near a screen edge the window cannot extend
    /// past the screen, so the wall is close. Aiming for a swing that does not fit is what flung
    /// him over the top: the wall stopped every swing short, so the push never switched off.
    /// </summary>
    private double PumpAcceleration()
    {
        double vx = Ankle.X - Ankle.PX;
        int direction = Math.Abs(vx) < 1e-4 ? 0 : Math.Sign(vx);
        if (direction != 0 && direction != lastDirection)
        {
            // He has just turned round, so the rope angle now is how far that half-swing went.
            lastPeak = Math.Abs(RopeAngle);
            lastDirection = direction;
        }

        double target = SwingRoom();
        if (touching || target < 0.09)              // 0.09 rad is about 5 degrees: no room to swing
        {
            return 0;
        }

        // Smooth, not on/off. Switching a fixed push on and off jolted his body against the rope
        // each time, and the swing visibly hitched at the bottom.
        //   shortfall: 1 = not swinging yet, 0 = on target, below 0 = too big, so it brakes gently.
        //   speed: strongest at the bottom of the swing, fading to nothing at the turning points.
        // Also counts how high he is right now, not only the last completed swing. Using only the
        // last swing, the first few swings got the full push all the way up and overshot to 57 degrees.
        double reached = Math.Max(lastPeak, Math.Abs(RopeAngle));
        double shortfall = Math.Clamp((target - reached) / target, -1, 1);
        double speed = Math.Clamp(vx / Step / 250, -1, 1);
        return PumpStrength * shortfall * speed;
    }

    /// <summary>
    /// The biggest swing (radians) that stays on screen on both sides, with a margin,
    /// and never more than SwingTarget.
    /// </summary>
    public double SwingRoom()
    {
        return Math.Min(SwingTarget, SwingRoomAt(Math.Min(
            Anchor.X - Math.Max(0, VisibleLeft),
            Math.Min(width, VisibleRight) - Anchor.X)));
    }

    /// <summary>The swing (radians) that fits when the nearer screen edge is `distance` from the anchor.</summary>
    public double SwingRoomAt(double distance)
    {
        double rope = Math.Max(1, (RopeCount - 1) * links[0].Length);
        // His body sticks out sideways from the rope end, and leans a little further out than the rope.
        double clear = distance - BodyLength * 0.42;
        double reach = rope + BodyLength * 0.5;
        return Math.Asin(Math.Clamp(clear / reach, 0, 1)) * 0.8;
    }

    /// <summary>How far the anchor must be from a screen edge for a full "swing on his own". Matches SwingRoomAt.</summary>
    public static double DistanceForFullSwing(double ropeLength, double bodyLength)
    {
        return bodyLength * 0.42 + (ropeLength + bodyLength * 0.5) * Math.Sin(SwingTarget / 0.8);
    }

    /// <summary>The largest distance any particle moved in the last step. Near 0 means he is still.</summary>
    public double Motion()
    {
        double max = 0;
        foreach (var p in particles)
        {
            max = Math.Max(max, StepDistance(p));
        }
        return max;
    }

    /// <summary>Zeroes every speed. Called just before the overlay stops drawing, so he wakes up still.</summary>
    public void Freeze()
    {
        foreach (var p in particles)
        {
            p.PX = p.X;
            p.PY = p.Y;
        }
    }

    private static double StepDistance(Particle p)
    {
        return Math.Abs(p.X - p.PX) + Math.Abs(p.Y - p.PY);
    }

    public bool NearAnchor(Point pt)
    {
        return Math.Abs(pt.X - Anchor.X) < 16 && pt.Y < Anchor.Y + 18;
    }

    /// <summary>Returns the ankle or head if the point is on his body, else null.</summary>
    public Particle? PickBody(Point pt)
    {
        double sx = Head.X - Ankle.X;
        double sy = Head.Y - Ankle.Y;
        double lenSq = Math.Max(1, sx * sx + sy * sy);
        double t = Math.Clamp(((pt.X - Ankle.X) * sx + (pt.Y - Ankle.Y) * sy) / lenSq, 0, 1);
        double nearX = Ankle.X + sx * t;
        double nearY = Ankle.Y + sy * t;

        if (Math.Sqrt((pt.X - nearX) * (pt.X - nearX) + (pt.Y - nearY) * (pt.Y - nearY)) < BodyLength * 0.3)
        {
            return t > 0.5 ? Head : Ankle;
        }
        return null;
    }

    /// <summary>Returns what the user grabbed: an end of the body, or the nearest rope point.</summary>
    public Particle? Pick(Point pt)
    {
        var body = PickBody(pt);
        if (body != null)
        {
            return body;
        }

        Particle? best = null;
        double bestDist = 18;
        for (int i = 1; i < RopeCount - 1; i++)
        {
            var p = particles[i];
            double d = Math.Sqrt((pt.X - p.X) * (pt.X - p.X) + (pt.Y - p.Y) * (pt.Y - p.Y));
            if (d < bestDist)
            {
                best = p;
                bestDist = d;
            }
        }
        return best;
    }

    private static void Solve(Particle a, Particle b, double length)
    {
        double wsum = a.W + b.W;
        if (wsum == 0)
        {
            return;
        }
        double dx = b.X - a.X;
        double dy = b.Y - a.Y;
        double d = Math.Max(1e-6, Math.Sqrt(dx * dx + dy * dy));
        double diff = (d - length) / d;
        double ka = a.W / wsum * diff;
        double kb = b.W / wsum * diff;
        a.X += dx * ka;
        a.Y += dy * ka;
        b.X -= dx * kb;
        b.Y -= dy * kb;
    }

    /// <summary>Keeps everything inside the window, with a small bounce off the sides.</summary>
    private void Contain()
    {
        // Same side margin for rope and body. With a smaller margin for the rope, the rope could
        // slide past his hand at a wall and fold back, and the grip then flipped him over the top.
        double side = BodyLength * 0.42;
        touching = false;
        for (int i = 1; i < particles.Count; i++)
        {
            var p = particles[i];
            bool bodyPart = i >= RopeCount - 1;
            double floor = height - (bodyPart ? BodyLength * ReachPastHead : 4);

            // The sides soak up sideways speed, like a padded wall. Do NOT make them bounce.
            // Pressed against a wall, the rope keeps pulling his body back into it every step.
            // A bounce turned each of those pulls into fresh speed away from the wall, the energy
            // snowballed, and one ordinary push near a screen edge flung him over the top.
            if (p.X < side)
            {
                p.X = p.PX = side;
                touching = true;
            }
            else if (p.X > width - side)
            {
                p.X = p.PX = width - side;
                touching = true;
            }

            if (p.Y > floor)
            {
                p.Y = p.PY = floor;
            }
            else if (p.Y < 1)
            {
                p.Y = p.PY = 1;
                touching = true;
            }
        }
    }
}
