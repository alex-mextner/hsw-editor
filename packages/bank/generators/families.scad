// HSW parametric holder families (project original, mm).
//
// Frame (fixed by the bank pipeline, do not rotate): the wall face of every part lies in the plane
// z = 0 and the body grows towards +z (the part as printed, wall face down); x is to the right and y
// UP when looking at the wall from the room. (0,0) is the centre of the anchor honeycomb cell.
//
// HSW lattice: hex cells, neighbouring columns colPitch = 20.4382 apart in x, row pitch 23.6 in y,
// neighbouring columns staggered by half a row (11.8): every cell centre is
// (dCol * 20.4382, dRow2 * 11.8) with dRow2 = dCol (mod 2). Mounting follows the proven project holders
// (refit/holders.scad): a 6 mm flat back plate with 3.4 mm M3 clearance holes EXACTLY on cell centres
// (RostaP M3 inserts), rounded corners r = 2, ribs/webs for every arm. Nothing but the screw holes
// pierces the plate, because the pipeline reads the holes of the wall-face section as mounting cells.
// Hole columns are kept clear of arms so a screwdriver can reach every screw along +z.
//
// Every parameter below is a top-level variable whose default equals the ParamDef default in
// families.json; the pipeline overrides them with -D key=value and selects the family with -D part=...
//
// Size ladders (the real sizes of the tools/stock each rung is made for):
//  - hex keys: ISO 2936 series 1.5 2 2.5 3 4 5 6 8 10 12 14 17 19 mm; hole = across-corners
//    (flat * 2/sqrt(3)) + 0.8 mm clearance.
//  - driver bits: 1/4" hex shank (ISO 1173 E6.3, 6.35 mm across flats) -> hex pocket 7.7 mm across corners.
//  - tape cores: 1" (25.4), 40 and 3" (76.2) mm; common tape widths 12 19 25 38 50 mm.
//  - spool bores 8 16 25 32 50 mm (thread/wire/cable reels), spool widths 30 50 70 mm.
//  - wrench head widths 20/30/40 mm (open-end 8-10 / 13-17 / 19-24 mm size classes);
//    slot x = 0.55*head + 1.5 (handle width), slot z = 0.16*head + 3.5 (handle thickness).
//  - spray cans 40 50 60 65 70 80 mm (aerosol cans 40-65, paint/lubricant tins up to 80).
//  - pliers jaw thickness 10 (needle) .. 24 (slip-joint) mm closed.
//  - screwdriver slot pitch is the handle collar + 4 mm (22 mm collar = common 5-8 mm shaft drivers).
// Wide parts stay <= 250 mm so every rung fits the 256 x 256 mm bed of a Bambu Lab A1.

part = "screwdriver_rail";

// ---- parameters (defaults == ParamDef defaults) ----
slots = 4;
holeDiameter = 6;
handleDiameter = 22;
coreDiameter = 40;
rollWidth = 25;
jawThickness = 14;
jawWidth = 32;
maxWrenchWidth = 30;
keys = 9;
startSize = 1.5;
spacing = 7;
reach = 60;
barDiameter = 8;
tipRise = 25;
widthCells = 3;
depth = 60;
width = 80;
height = 50;
innerDiameter = 40;
cupHeight = 80;
bodyWidth = 38;
armLength = 100;
handleWidth = 30;
forkLength = 70;
boreDiameter = 25;
spoolWidth = 50;
canDiameter = 65;
ringHeight = 12;
bladeThickness = 8;
slotLength = 38;
slotWidth = 10;
slotThickness = 5;
bitsPerRow = 10;
rows = 2;
rodDiameter = 10;
rodLength = 160;
strapWidth = 35;
hangerReach = 70;
beamWidth = 20;
beamThickness = 4;

$fn = 48;

// ---- lattice and plate ----
COL = 20.4382;
ROW2 = 11.8;
T = 6;
RACK_TOP = 46;
HOLE_D = 3.4;
EPS = 0.01;

function cellx(c) = c * COL;
function celly(r) = r * ROW2;

// M3 holes in a zig-zag: odd columns alternate between rows +1 and -1 (vertical offset 23.6 between
// neighbours), as many columns as fit a plate of width w with 7 mm to the edge.
function zig(w) = [for (c = [-21:2:21]) if (abs(c) * COL <= w / 2 - 7) [c, ((c - 1) / 2) % 2 == 0 ? -1 : 1]];
// Same columns with both rows (heavy loads).
function zig2(w) = [for (c = [-21:2:21], r = [-1, 1]) if (abs(c) * COL <= w / 2 - 7) [c, r]];

module rrect(x0, x1, y0, y1, h, r = 2) {
    linear_extrude(h) hull()
        for (x = [x0 + r, x1 - r], y = [y0 + r, y1 - r]) translate([x, y]) circle(r = r, $fn = 24);
}

module screw_holes(cells) {
    for (c = cells) translate([cellx(c[0]), celly(c[1]), -1]) cylinder(d = HOLE_D, h = T + 2);
}

module plate(x0, x1, y0, y1, cells) {
    difference() {
        rrect(x0, x1, y0, y1, T);
        screw_holes(cells);
    }
}

// Triangular web: polygon points are [y, z]; the web spans x .. x + t.
module gusset(x, t, pts) {
    translate([x, 0, 0]) rotate([90, 0, 90]) linear_extrude(t) polygon(pts);
}

// Cut through a shelf from above: children are 2D shapes in (x, z); the cut goes h mm down from ytop.
module ycut(ytop, h) {
    translate([0, ytop, 0]) rotate([90, 0, 0]) linear_extrude(h) children();
}

// Back plate (zig-zag M3 holes) + horizontal shelf of thickness th and depth d on top + webs under
// the shelf (end webs always, ribs at the given x positions). Children are subtracted from the shelf
// (never from the plate or the webs).
module rack(w0, d, th = 8, rise = 0, ribs = [], ribt = 3, heavy = false) {
    // Quantised so the plate, shelf and end webs share bit-identical side faces (no sliver edges in the STL).
    w = ceil(w0 * 4) / 4;
    ribh = min(16, RACK_TOP - th - 18);
    ribz = min(d - 5, T + 50);
    union() {
        plate(-w / 2, w / 2, -20, RACK_TOP + rise, heavy ? zig2(w) : zig(w));
        difference() {
            translate([-w / 2, RACK_TOP - th, 0]) cube([w, th, d]);
            children();
        }
        if (ribh > 3)
            for (x = concat([-w / 2, w / 2 - ribt], [for (xr = ribs) xr - ribt / 2]))
                gusset(x, ribt, [[RACK_TOP - th, T - 1], [RACK_TOP - th, ribz], [RACK_TOP - th - ribh, T - 1]]);
    }
}

// Hub / axle on a back plate; screws sit on the column above and below the hub clear of the lip.
module axle_plate(clearR, halfW) {
    k = ceil((clearR + 5) / (2 * ROW2));
    ph = k * 2 * ROW2 + 8;
    plate(-halfW, halfW, -ph, ph, [[0, 2 * k], [0, -2 * k]]);
}

// ================= 1. screwdriver rail =================
module screwdriver_rail() {
    p = max(handleDiameter + 4, 18);
    w = max(slots * p + 8, 56);
    zc = T + 3 + handleDiameter / 2;
    d = zc + handleDiameter / 2 + 2;
    rack(w, d, 8, 0, [for (i = [1:slots - 1]) (i - slots / 2) * p]) {
        for (i = [0:slots - 1]) {
            x = (i - (slots - 1) / 2) * p;
            translate([x, RACK_TOP + 1, zc]) rotate([90, 0, 0]) cylinder(d = holeDiameter, h = 10);
            translate([x, RACK_TOP + EPS, zc]) rotate([90, 0, 0])
                cylinder(d1 = holeDiameter + 3, d2 = holeDiameter, h = 1.5);
        }
    }
}

// ================= 2. tape roll holder =================
// 25 and 40 mm cores sit on a hub 2 mm under the core; a 76 mm core rides on a 60 mm hub (loose, it
// rests on the top of the hub). The hub is a hollow tube printed standing on its base (no supports).
module tape_roll_holder() {
    axD = coreDiameter <= 40 ? coreDiameter - 2 : coreDiameter - 16;
    len = rollWidth + 8;
    lipD = axD + 10;
    axle_plate(lipD / 2, max(axD / 2 + 8, 20));
    difference() {
        union() {
            translate([0, 0, T - 1]) cylinder(d = axD, h = len + 1);
            translate([0, 0, T + len - 8]) cylinder(d1 = axD, d2 = lipD, h = 5);
            translate([0, 0, T + len - 3]) cylinder(d = lipD, h = 3);
        }
        translate([0, 0, T + 3]) cylinder(d = axD - 6, h = len + 1);
    }
}

// ================= 3. pliers rack =================
// Pliers hang by the closed jaws in a slot (plane of the pliers perpendicular to the wall), the
// handles splay front and back and rest on the shelf.
module pliers_rack() {
    p = jawThickness + 12;
    sx = jawThickness + 2;
    w = max(slots * p + 12, 56);
    d = T + 4 + (jawWidth + 2) + 8;
    rack(w, d, 8, 0, [for (i = [1:slots - 1]) (i - slots / 2) * p]) {
        ycut(RACK_TOP + 1, 12) for (i = [0:slots - 1]) {
            x = (i - (slots - 1) / 2) * p;
            translate([x, T + 4 + (jawWidth + 2) / 2]) offset(r = 1.5) square([sx - 3, jawWidth + 2 - 3], center = true);
        }
    }
}

// ================= 4. wrench rack =================
// Open-end wrenches hang flat to the wall by the handle through a slot, the head rests on the shelf.
module wrench_rack() {
    p = maxWrenchWidth + 6;
    sx = round(0.55 * maxWrenchWidth * 2) / 2 + 1.5;
    sz = 0.16 * maxWrenchWidth + 3.5;
    w = max(slots * p + 12, 56);
    d = T + 2 + sz + 10;
    rack(w, d, 8, 0, [for (i = [1:slots - 1]) (i - slots / 2) * p]) {
        ycut(RACK_TOP + 1, 12) for (i = [0:slots - 1]) {
            x = (i - (slots - 1) / 2) * p;
            translate([x, T + 2 + sz / 2]) offset(r = 1.5) square([sx - 3, sz - 3], center = true);
        }
    }
}

// ================= 5. hex key holder =================
HEX = [1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 14, 17, 19];
function hexd(s) = 2 / sqrt(3) * s + 0.8;
// First series entry >= startSize; the row holds `keys` consecutive entries (clamped to the series end).
function hex0() = [for (i = [0:len(HEX) - 1]) if (HEX[i] >= startSize) i][0];
function hexn() = min(keys, len(HEX) - hex0());
function hexsize(i) = HEX[hex0() + i];
function hexx(i) = i == 0 ? 0 : hexx(i - 1) + max(spacing, (hexd(hexsize(i - 1)) + hexd(hexsize(i))) / 2 + 4);
module hex_key_holder() {
    n = hexn();
    xs = [for (i = [0:n - 1]) hexx(i)];
    last = xs[n - 1];
    first = hexd(hexsize(0));
    maxd = hexd(hexsize(n - 1));
    w = max(last + (first + maxd) / 2 + 16, 56);
    zc = T + 3 + maxd / 2;
    d = zc + maxd / 2 + 6;
    rack(w, d, 12, 0, []) {
        for (i = [0:n - 1])
            translate([xs[i] - last / 2, RACK_TOP + 1, zc]) rotate([90, 0, 0]) cylinder(d = hexd(hexsize(i)), h = 14);
    }
}

// ================= 6. J hook =================
module j_hook() {
    r = barDiameter / 2;
    zt = reach - r;
    t = max(4, barDiameter * 0.5);
    plate(-28, 28, -20, 20, [[-1, 1], [1, -1]]);
    translate([0, 0, T - 1]) cylinder(d = barDiameter, h = zt - (T - 1));
    translate([0, 0, zt]) sphere(r = r);
    translate([0, 0, zt]) rotate([-90, 0, 0]) cylinder(d = barDiameter, h = tipRise);
    translate([0, tipRise, zt]) sphere(r = r);
    gusset(-t / 2, t, [[-r * 0.4, T - 1], [-r * 0.4, min(zt, T + 54)], [-18, T - 1]]);
}

// ================= 7. shelf ledge =================
module shelf_ledge() {
    w = ceil(widthCells * 2 * COL * 4) / 4;
    union() {
        rack(w, depth, 8, 12, [for (m = [-6:6]) if (abs(m * 2 * COL) < w / 2 - 3) m * 2 * COL], 3, true) {}
        translate([-w / 2, RACK_TOP - 8, depth - 4]) cube([w, 20, 4]);
    }
}

// ================= 8. open bin =================
module bin_open() {
    wall = 2.4;
    floorT = 3;
    pw = max(width, 56);
    ybot = -20 - height;
    plate(-pw / 2, pw / 2, -20, 20, zig(pw));
    rrect(-width / 2, width / 2, ybot, -19, T);
    difference() {
        translate([-width / 2, ybot, 0]) cube([width, height, depth]);
        translate([-width / 2 + wall, ybot + floorT, T]) cube([width - 2 * wall, height, depth - wall - T]);
        // Front scoop on bins deep enough to need one.
        if (height >= 50) {
            nw = width * 0.6;
            r = min(8, nw / 2 - 1);
            translate([0, 0, depth - wall - 1]) linear_extrude(wall + 2) hull() {
                for (s = [-1, 1]) translate([s * (nw / 2 - r), ybot + height * 0.45 + r]) circle(r = r);
                translate([-nw / 2, -21]) square([nw, 2]);
            }
        }
    }
}

// ================= 9. round cup =================
module cup_round() {
    wall = 2.4;
    floorT = 3;
    R = innerDiameter / 2 + wall;
    z0 = T + R - 1.5;
    ybot = -20 - cupHeight;
    pw = max(R + 4, 28);
    plate(-pw, pw, -20, 20, zig(2 * pw));
    rrect(-R * 0.9, R * 0.9, ybot, -19, T);
    difference() {
        union() {
            translate([0, ybot, z0]) rotate([-90, 0, 0]) cylinder(r = R, h = cupHeight, $fn = 96);
            translate([-0.7 * R, ybot, T - 1]) cube([1.4 * R, cupHeight, z0 - (T - 1)]);
        }
        translate([0, ybot + floorT, z0]) rotate([-90, 0, 0]) cylinder(r = R - wall, h = cupHeight, $fn = 96);
    }
}

// ================= 10. drill cradle =================
// Two arms with front stops; the drill neck sits between them, the body rests on top of the arms.
module drill_cradle() {
    gap = bodyWidth + 3;
    armW = 22;
    w = gap + 2 * armW + 12;
    armC = gap / 2 + armW / 2;
    union() {
        rack(w, armLength, 10, 0, [-armC, armC], 4, true) {
            ycut(RACK_TOP + 1, 14) hull() {
                translate([0, T + 4 + gap / 2]) circle(d = gap, $fn = 64);
                translate([-gap / 2, armLength - 1]) square([gap, 2]);
            }
        }
        for (s = [-1, 1]) translate([s * armC - armW / 2, RACK_TOP, armLength - 5]) cube([armW, 12, 5]);
    }
}

// ================= 11. hammer fork =================
// Narrow tines with a rounded throat; the head rests on the tines, the handle drops between them and
// a peg on each tine tip stops it sliding off.
module hammer_fork() {
    gap = handleWidth + 3;
    tw = 14;
    w = gap + 2 * tw + 12;
    armC = gap / 2 + tw / 2;
    union() {
        rack(w, forkLength, 8, 0, [-armC, armC], 4, true) {
            ycut(RACK_TOP + 1, 12) hull() {
                translate([0, T + 4 + gap / 2]) circle(d = gap, $fn = 64);
                translate([-gap / 2, forkLength - 1]) square([gap, 2]);
            }
        }
        for (s = [-1, 1]) translate([s * armC, RACK_TOP - 1, forkLength - 6]) rotate([-90, 0, 0]) cylinder(d = 8, h = 11);
    }
}

// ================= 12. spool holder =================
// Axle for reels: root flange, tapered shoulder, spool slides on from the front over a shaft 1.5 mm
// under the bore and is kept by a conical lip. Hollow above 20 mm.
module spool_holder() {
    axD = boreDiameter - 1.5;
    len = spoolWidth + 25;
    flangeD = axD + 14;
    lipD = axD + 8;
    axle_plate(flangeD / 2, max(flangeD / 2 + 4, 20));
    difference() {
        union() {
            translate([0, 0, T - 1]) cylinder(d = flangeD, h = 4);
            translate([0, 0, T + 3]) cylinder(d1 = axD + 10, d2 = axD, h = 14);
            translate([0, 0, T - 1]) cylinder(d = axD, h = len + 1);
            translate([0, 0, T + len - 6]) cylinder(d1 = axD, d2 = lipD, h = 4);
            translate([0, 0, T + len - 2]) cylinder(d = lipD, h = 2);
        }
        if (axD >= 20) translate([0, 0, T + 4]) cylinder(d = axD - 6, h = len + 1);
    }
}

// ================= 13. spray can holder =================
// Horizontal ring with a front opening narrower than the can; the can drops in from above.
module spray_can_holder() {
    w = max(canDiameter + 24, 56);
    zc = T + canDiameter / 2 + 3;
    d = zc + canDiameter / 2 + 9;
    rack(w, d, ringHeight, 0, [-(canDiameter / 2 + 6.4), canDiameter / 2 + 6.4], 4, true) {
        ycut(RACK_TOP + 1, ringHeight + 2) {
            translate([0, zc]) circle(d = canDiameter + 1.5, $fn = 96);
            translate([-0.4 * canDiameter, zc]) square([0.8 * canDiameter, d - zc + 1]);
        }
    }
}

// ================= 14. scissors slot rack =================
// Slots open to the front; scissors/knives hang by the closed blades.
module scissors_slot() {
    p = bladeThickness + 18;
    sx = bladeThickness + 2;
    w = max(slots * p + 12, 56);
    d = T + 3 + slotLength;
    rack(w, d, 8, 0, [for (i = [1:slots - 1]) (i - slots / 2) * p]) {
        ycut(RACK_TOP + 1, 12) for (i = [0:slots - 1]) {
            x = (i - (slots - 1) / 2) * p;
            hull() {
                translate([x, T + 3 + sx / 2]) circle(d = sx, $fn = 32);
                translate([x - sx / 2, d - 1]) square([sx, 2]);
            }
        }
    }
}

// ================= 15. file rack =================
// Deep blind pockets on a thick bar: files, rasps and saw blades stand on edge against the wall.
module file_rack() {
    p = slotWidth + 10;
    sx = slotWidth + 1.5;
    w = max(slots * p + 12, 56);
    d = T + 3 + slotThickness + 9;
    rack(w, d, 18, 0, [for (i = [1:slots - 1]) (i - slots / 2) * p]) {
        ycut(RACK_TOP + 1, 14) for (i = [0:slots - 1]) {
            x = (i - (slots - 1) / 2) * p;
            translate([x, T + 3 + slotThickness / 2]) offset(r = 1) square([sx - 2, slotThickness - 2], center = true);
        }
    }
}

// ================= 16. bit block =================
// Blind hex pockets (1/4" hex shank) in rows along the shelf depth, pitch 12 mm.
module bit_block() {
    w = max(bitsPerRow * 12 + 16, 56);
    d = T + 3 + rows * 12 + 3;
    rack(w, d, 16, 0, []) {
        for (i = [0:bitsPerRow - 1], j = [0:rows - 1])
            translate([(i - (bitsPerRow - 1) / 2) * 12, RACK_TOP + 1, T + 3 + 6 + j * 12]) rotate([90, 0, 0])
                cylinder(d = 7.7, h = 13, $fn = 6);
    }
}

// ================= 17. clamp bar =================
// Round bar between two end brackets: bar clamps, quick clamps and pipe clamps hang over it.
module clamp_bar() {
    ry = 34;
    r = rodDiameter / 2;
    zr = T + 22 + r;
    w = rodLength + 20;
    plate(-w / 2, w / 2, -20, ry + r + 8, zig(w));
    for (s = [-1, 1]) translate([s * rodLength / 2 - 3, ry - r - 4, T - 1]) cube([6, 2 * r + 8, zr + 3 - (T - 1)]);
    translate([-rodLength / 2 - 3, ry, zr]) rotate([0, 90, 0]) cylinder(d = rodDiameter, h = rodLength + 6);
}

// ================= 18. cable hanger =================
// Flat strap hook with an up-turned tip for coils of cable, hose and rope.
module cable_hanger() {
    w = max(strapWidth + 16, 56);
    plate(-w / 2, w / 2, -20, 20, zig(w));
    translate([-strapWidth / 2, 0, 0]) rotate([90, 0, 90]) linear_extrude(strapWidth)
        offset(r = 2) offset(delta = -2) union() {
            translate([-4, T - 1]) square([8, hangerReach - (T - 1)]);
            translate([-4, hangerReach - 8]) square([26, 8]);
        }
    gusset(-2, 4, [[-4 + 0.5, T - 1], [-4 + 0.5, min(hangerReach - 8, T + 54)], [-18, T - 1]]);
}

// ================= 19. caliper cradle =================
// Slots for the caliper beam with a funnel lead-in on top; the slider rests on the shelf (pitch = slot + 30).
module caliper_cradle() {
    sx = beamWidth + 2;
    sz = beamThickness + 2.5;
    p = sx + 30;
    w = max(slots * p + 12, 56);
    d = T + 3 + sz + 12;
    zc = T + 3 + sz / 2;
    rack(w, d, 10, 0, [for (i = [1:slots - 1]) (i - slots / 2) * p], 4, true) {
        for (i = [0:slots - 1]) {
            x = (i - (slots - 1) / 2) * p;
            ycut(RACK_TOP + 1, 12) translate([x, zc]) offset(r = 1) square([sx - 2, sz - 2], center = true);
            translate([x, RACK_TOP + EPS, zc]) rotate([90, 0, 0])
                linear_extrude(4, scale = [sx / (sx + 6), sz / (sz + 6)]) square([sx + 6, sz + 6], center = true);
        }
    }
}

if (part == "screwdriver_rail") screwdriver_rail();
else if (part == "tape_roll_holder") tape_roll_holder();
else if (part == "pliers_rack") pliers_rack();
else if (part == "wrench_rack") wrench_rack();
else if (part == "hex_key_holder") hex_key_holder();
else if (part == "j_hook") j_hook();
else if (part == "shelf_ledge") shelf_ledge();
else if (part == "bin_open") bin_open();
else if (part == "cup_round") cup_round();
else if (part == "drill_cradle") drill_cradle();
else if (part == "hammer_fork") hammer_fork();
else if (part == "spool_holder") spool_holder();
else if (part == "spray_can_holder") spray_can_holder();
else if (part == "scissors_slot") scissors_slot();
else if (part == "file_rack") file_rack();
else if (part == "bit_block") bit_block();
else if (part == "clamp_bar") clamp_bar();
else if (part == "cable_hanger") cable_hanger();
else if (part == "caliper_cradle") caliper_cradle();
else assert(false, str("Unknown part: ", part));
