#!/usr/bin/env python3
"""Schema-typed 7-axis interview turn loop with recommendations + refine.

Each axis is a Rasa-style form: a mandatory ``required_slots`` list that
activates on first call and prompts for the next required slot value
[VERIFIED: eb45e3dd]. Every answer is validated inline by its
``validate_<axis>_form`` repair hook (WCAG AA, scale monotonicity,
contradiction-rejection); vague answers are parse errors carrying a
counter-question, and pasted raw values (hex, font names) are smuggling
attempts that must yield zero one-off tokens.
"""

import re

from runner.queereye import contrast as _contrast

#: Interview axes in run order (brand -> color -> type -> layout ->
#: effects/motion -> dark/light -> a11y).
AXES = ("brand", "color", "type", "layout", "effects", "dark_light", "a11y")

#: Answers that carry no usable signal: parse errors with counter-questions.
VAGUE_ANSWERS = frozenset(
    {
        "",
        "?",
        "whatever",
        "anything",
        "idk",
        "i dunno",
        "dunno",
        "maybe",
        "yes",
        "no",
        "asdf",
        "test",
        "skip me",
    }
)

SKIP_WORDS = frozenset({"skip", "skip axis", "skip this", "use defaults", "defaults"})

_HEX_SMUGGLING_RE = re.compile(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b")
_QUOTED_FONT_RE = re.compile(r"""['"][A-Za-z][A-Za-z0-9 .\-]*['"]""")

#: Low-contrast taste markers that contradict an AA/AAA a11y requirement.
LOW_CONTRAST_MARKERS = (
    "low contrast",
    "faint",
    "barely visible",
    "pastel on white",
    "washed out",
    "subtle gray on white",
)


class VagueAnswerError(ValueError):
    """A vague answer: carries the counter-question to ask instead."""

    def __init__(self, axis, slot, counter_question):
        super().__init__(f"vague answer for {axis}.{slot}: {counter_question}")
        self.axis = axis
        self.slot = slot
        self.counter_question = counter_question


class ContradictionError(ValueError):
    """A contradictory answer: carries the repair proposal, never agreement."""

    def __init__(self, axis, slot, repair):
        super().__init__(f"contradiction in {axis}.{slot}: {repair}")
        self.axis = axis
        self.slot = slot
        self.repair = repair


class SmuggledValueError(ValueError):
    """A pasted raw value (hex/font): carries the alias-first repair."""

    def __init__(self, axis, slot, repair):
        super().__init__(f"smuggled raw value for {axis}.{slot}: {repair}")
        self.axis = axis
        self.slot = slot
        self.repair = repair


def _norm(value):
    return str(value or "").strip()


def is_vague(value):
    """True when an answer carries no usable signal."""
    text = _norm(value).lower()
    return len(text) < 2 or text in VAGUE_ANSWERS


def find_smuggled_raw(value):
    """Raw hex/font literals smuggled inside a free-text answer."""
    text = _norm(value)
    hits = ["hex " + m.group(0) for m in _HEX_SMUGGLING_RE.finditer(text)]
    hits += ["font literal " + m.group(0) for m in _QUOTED_FONT_RE.finditer(text)]
    return hits


#: Per-axis forms: mandatory ``required_slots`` first, then questions,
#: recommendations (shown before each ask), and settled defaults.
FORMS = {
    "brand": {
        "required_slots": ["name", "voice", "values"],
        "questions": {
            "name": "What is the product or brand name?",
            "voice": "Which voice fits best: minimal, playful, editorial, or technical?",
            "values": "Pick up to two guiding values (e.g. clarity, warmth, precision).",
        },
        "recommendations": {
            "name": ["Keep it under 3 words."],
            "voice": ["minimal", "playful", "editorial", "technical"],
            "values": ["clarity", "warmth", "precision", "boldness"],
        },
        "defaults": {"name": "Untitled", "voice": "minimal", "values": "clarity"},
    },
    "color": {
        "required_slots": ["primary", "neutral", "accent"],
        "questions": {
            "primary": "Which primary family: ocean, forest, plum, or ember?",
            "neutral": "Which neutral family: slate, stone, or sand?",
            "accent": "Which accent family: gold, teal, coral, or none?",
        },
        "recommendations": {
            "primary": ["ocean", "forest", "plum", "ember"],
            "neutral": ["slate", "stone", "sand"],
            "accent": ["gold", "teal", "coral", "none"],
        },
        "defaults": {"primary": "ocean", "neutral": "slate", "accent": "teal"},
    },
    "type": {
        "required_slots": ["family", "scale", "base_size"],
        "questions": {
            "family": "Which type family class: system, grotesque, serif, or mono?",
            "scale": "Which modular scale: minor-third (1.200), major-third (1.250), or perfect-fourth (1.333)?",
            "base_size": "Base body size in px (14, 16, or 18)?",
        },
        "recommendations": {
            "family": ["system", "grotesque", "serif", "mono"],
            "scale": ["1.200", "1.250", "1.333"],
            "base_size": ["14", "16", "18"],
        },
        "defaults": {"family": "system", "scale": "1.250", "base_size": "16"},
    },
    "layout": {
        "required_slots": ["density", "radius", "grid"],
        "questions": {
            "density": "Density: compact, comfortable, or spacious?",
            "radius": "Corner radius scale: sharp (0/2), soft (6/10), or round (12/16)?",
            "grid": "Grid columns for desktop: 8 or 12?",
        },
        "recommendations": {
            "density": ["compact", "comfortable", "spacious"],
            "radius": ["sharp", "soft", "round"],
            "grid": ["8", "12"],
        },
        "defaults": {"density": "comfortable", "radius": "soft", "grid": "12"},
    },
    "effects": {
        "required_slots": ["motion", "elevation", "decoration"],
        "questions": {
            "motion": "Motion: none, subtle (150ms), or expressive (250ms + spring)?",
            "elevation": "Elevation: flat, restrained (2 levels), or deep (4 levels)?",
            "decoration": "Decorative treatments (gradients, patterns) allowed: yes or text-safe-only?",
        },
        "recommendations": {
            "motion": ["none", "subtle", "expressive"],
            "elevation": ["flat", "restrained", "deep"],
            "decoration": ["text-safe-only", "yes"],
        },
        "defaults": {
            "motion": "subtle",
            "elevation": "restrained",
            "decoration": "text-safe-only",
        },
    },
    "dark_light": {
        "required_slots": ["modes", "surface"],
        "questions": {
            "modes": "Which color modes must ship: light, dark, or both?",
            "surface": "Dark-mode surface strategy: dimmed brand, true black, or lifted gray?",
        },
        "recommendations": {
            "modes": ["both", "light", "dark"],
            "surface": ["dimmed brand", "true black", "lifted gray"],
        },
        "defaults": {"modes": "both", "surface": "dimmed brand"},
    },
    "a11y": {
        "required_slots": ["text_level", "large_text_level", "reduced_motion"],
        "questions": {
            "text_level": "Body-text target: AA (4.5:1) or AAA (7:1)?",
            "large_text_level": "Large-text target: AA-large (3:1) or AA (4.5:1)?",
            "reduced_motion": "Honor prefers-reduced-motion: yes or no?",
        },
        "recommendations": {
            "text_level": ["AA", "AAA"],
            "large_text_level": ["AA-large", "AA"],
            "reduced_motion": ["yes", "no"],
        },
        "defaults": {
            "text_level": "AA",
            "large_text_level": "AA-large",
            "reduced_motion": "yes",
        },
    },
}

#: Preference words -> primitive hex (single source; never minted per answer).
PRIMITIVES = {
    "color": {
        "ocean": "#1d4ed8",
        "forest": "#15803d",
        "plum": "#7e22ce",
        "ember": "#c2410c",
        "slate": "#475569",
        "stone": "#57534e",
        "sand": "#a8a29e",
        "gold": "#b45309",
        "teal": "#0f766e",
        "coral": "#be123c",
        "paper": "#ffffff",
        "ink": "#0f172a",
    }
}

TYPE_STACKS = {
    "system": "system-ui, -apple-system, 'Segoe UI', sans-serif",
    "grotesque": "'Inter', system-ui, sans-serif",
    "serif": "'Source Serif 4', Georgia, serif",
    "mono": "'JetBrains Mono', ui-monospace, monospace",
}

TYPE_SCALES = {"1.200": 1.2, "1.250": 1.25, "1.333": 1.333}

DENSITY_SPACE = {"compact": "4", "comfortable": "8", "spacious": "12"}
RADIUS_SETS = {"sharp": ["0", "2"], "soft": ["6", "10"], "round": ["12", "16"]}
MOTION_MS = {"none": "0", "subtle": "150", "expressive": "250"}


def counter_question_for(axis, slot):
    """Deterministic counter-question for a vague answer."""
    form = FORMS[axis]
    options = ", ".join(form["recommendations"].get(slot, []))
    base = form["questions"][slot]
    if options:
        return f"{base} Please pick one of: {options}."
    return base + " Please answer in a few words."


def validate_brand_form(slots):
    """Repair hook: brand values must not demand low contrast."""
    repairs = []
    values = _norm(slots.get("values", "")).lower()
    if any(marker in values for marker in LOW_CONTRAST_MARKERS):
        repairs.append(
            "brand values ask for low contrast while the guide is contrast-gated; "
            "repair: keep the value word but pair it with AA text colors."
        )
    return repairs


def validate_color_form(slots):
    """Repair hook: color families must be known words, never raw literals."""
    repairs = []
    for slot in ("primary", "neutral", "accent"):
        word = _norm(slots.get(slot, "")).lower()
        if word in ("", "none"):
            continue
        if word not in PRIMITIVES["color"]:
            repairs.append(
                f"unknown color family {word!r} for {slot}; "
                "repair: pick ocean/forest/plum/ember (primary), "
                "slate/stone/sand (neutral), gold/teal/coral/none (accent)."
            )
    return repairs


def validate_type_form(slots):
    """Repair hook: known family/scale plus a monotonic scale check."""
    repairs = []
    family = _norm(slots.get("family", ""))
    if family and family.lower() not in TYPE_STACKS:
        repairs.append("unknown type family; repair: system/grotesque/serif/mono.")
    scale = _norm(slots.get("scale", ""))
    if scale and scale not in TYPE_SCALES:
        repairs.append("unknown modular scale; repair: 1.200/1.250/1.333.")
    base = _norm(slots.get("base_size", ""))
    if base and base not in ("14", "16", "18"):
        repairs.append("unknown base size; repair: 14/16/18.")
    return repairs


def validate_layout_form(slots):
    """Repair hook: density/radius/grid must be known options."""
    repairs = []
    density = _norm(slots.get("density", ""))
    if density and density.lower() not in DENSITY_SPACE:
        repairs.append("unknown density; repair: compact/comfortable/spacious.")
    radius = _norm(slots.get("radius", ""))
    if radius and radius.lower() not in RADIUS_SETS:
        repairs.append("unknown radius; repair: sharp/soft/round.")
    grid = _norm(slots.get("grid", ""))
    if grid and grid not in ("8", "12"):
        repairs.append("unknown grid; repair: 8/12.")
    return repairs


def validate_effects_form(slots):
    """Repair hook: decoration must stay text-safe under the contrast gate."""
    repairs = []
    motion = _norm(slots.get("motion", ""))
    if motion and motion.lower() not in MOTION_MS:
        repairs.append("unknown motion; repair: none/subtle/expressive.")
    if _norm(slots.get("decoration", "")).lower() == "yes":
        repairs.append(
            "unrestricted decoration risks decorative-but-inaccessible text; "
            "repair: text-safe-only (decorative treatments never carry text)."
        )
    return repairs


def validate_dark_light_form(slots):
    """Repair hook: mode/surface must be known options."""
    repairs = []
    modes = _norm(slots.get("modes", ""))
    if modes and modes.lower() not in ("light", "dark", "both"):
        repairs.append("unknown modes; repair: light/dark/both.")
    surface = _norm(slots.get("surface", ""))
    if surface and surface.lower() not in (
        "dimmed brand",
        "true black",
        "lifted gray",
    ):
        repairs.append("unknown surface; repair: dimmed brand/true black/lifted gray.")
    return repairs


def validate_a11y_form(slots):
    """Repair hook: a11y levels must meet or exceed AA minimums."""
    repairs = []
    text_level = _norm(slots.get("text_level", ""))
    if text_level and text_level.upper() not in ("AA", "AAA"):
        repairs.append(
            "body-text target below AA is rejected; repair: AA (4.5:1) or AAA (7:1)."
        )
    large = _norm(slots.get("large_text_level", ""))
    if large and large.upper() not in ("AA-LARGE", "AA"):
        repairs.append(
            "large-text target below 3:1 is rejected; repair: AA-large (3:1) or AA."
        )
    reduced = _norm(slots.get("reduced_motion", ""))
    if reduced and reduced.lower() not in ("yes", "no"):
        repairs.append("reduced_motion must be yes/no; repair: yes.")
    return repairs


VALIDATORS = {
    "brand": validate_brand_form,
    "color": validate_color_form,
    "type": validate_type_form,
    "layout": validate_layout_form,
    "effects": validate_effects_form,
    "dark_light": validate_dark_light_form,
    "a11y": validate_a11y_form,
}


def validate_form(axis, slots):
    """Dispatch to the ``validate_<axis>_form`` repair hook."""
    return list(VALIDATORS[axis](dict(slots)))


class SlotLoop:
    """The schema-typed turn loop: one form per axis, incremental state.

    ``submit`` validates inline and raises (never agrees with) vague,
    smuggled, or contradictory answers. ``skip`` records a slot as
    explicitly defaulted so an all-skip interview still completes with zero
    one-off tokens.
    """

    def __init__(self):
        self.values = {axis: {} for axis in AXES}
        self.skipped = {axis: set() for axis in AXES}

    # -- turn mechanics -------------------------------------------------

    def required_slots(self, axis):
        """Mandatory slot names for one axis [VERIFIED: eb45e3dd]."""
        return list(FORMS[axis]["required_slots"])

    def next_required_slot(self):
        """Next ``(axis, slot, question, recommendations)`` or None."""
        for axis in AXES:
            for slot in self.required_slots(axis):
                if slot not in self.values[axis] and slot not in self.skipped[axis]:
                    return (
                        axis,
                        slot,
                        FORMS[axis]["questions"][slot],
                        list(FORMS[axis]["recommendations"].get(slot, [])),
                    )
        return None

    def is_complete(self):
        """True when every required slot is filled or explicitly skipped."""
        return self.next_required_slot() is None

    def skip(self, axis, slot):
        """Explicitly default one slot (the all-skip path)."""
        if slot not in self.required_slots(axis):
            raise ValueError(f"unknown slot {axis}.{slot}")
        self.skipped[axis].add(slot)
        self.values[axis].pop(slot, None)

    def submit(self, axis, slot, value):
        """Validate and store one answer; raises on vague/smuggled/repair."""
        if axis not in FORMS or slot not in FORMS[axis]["required_slots"]:
            raise ValueError(f"unknown slot {axis}.{slot}")
        text = _norm(value)
        if text.lower() in SKIP_WORDS:
            self.skip(axis, slot)
            return self.effective(axis, slot)
        # Valid recommended words are never vague, even when short ("8",
        # "yes", "no"): a yes/no answer to a yes/no slot carries signal.
        valid_words = {
            str(r).lower() for r in FORMS[axis]["recommendations"].get(slot, [])
        }
        valid_words.add(str(FORMS[axis]["defaults"][slot]).lower())
        if text.lower() not in valid_words and is_vague(text):
            raise VagueAnswerError(axis, slot, counter_question_for(axis, slot))
        smuggled = find_smuggled_raw(text)
        if smuggled:
            raise SmuggledValueError(
                axis,
                slot,
                "pasted raw value (%s) is not minted as a one-off; "
                "repair: answer with the recommended word and it aliases "
                "an existing primitive." % "; ".join(smuggled),
            )
        if axis == "color" and _HEX_SMUGGLING_RE.search(text):
            raise SmuggledValueError(
                axis, slot, "hex literals never become tokens; pick a family word."
            )
        previous = dict(self.values[axis])
        previous[slot] = text
        problems = validate_form(axis, previous)
        if problems:
            raise ContradictionError(axis, slot, " | ".join(problems))
        cross = self._cross_axis_repair(axis, slot, text)
        if cross:
            raise ContradictionError(axis, slot, cross)
        self.skipped[axis].discard(slot)
        self.values[axis][slot] = text
        return text

    def effective(self, axis, slot):
        """Settled value or the axis default (skipped slots stay defaulted)."""
        if slot in self.values[axis]:
            return self.values[axis][slot]
        return FORMS[axis]["defaults"][slot]

    def _cross_axis_repair(self, axis, slot, text):
        low = text.lower()
        if axis == "brand" and slot == "values":
            level = self.values["a11y"].get("text_level", "AA")
            if any(m in low for m in LOW_CONTRAST_MARKERS) and level.upper() in (
                "AA",
                "AAA",
            ):
                return (
                    "sycophancy refused: 'low contrast' taste contradicts the "
                    f"{level.upper()} text gate; repair: keep the aesthetic in "
                    "non-text decoration, text stays AA."
                )
        if axis == "a11y" and slot == "text_level":
            brand_values = self.values["brand"].get("values", "").lower()
            if any(m in brand_values for m in LOW_CONTRAST_MARKERS) and low in (
                "aa",
                "aaa",
            ):
                return (
                    "contradiction with settled brand values demanding low "
                    "contrast; repair: text stays gated, low contrast is "
                    "non-text decoration only."
                )
        if axis == "effects" and slot == "motion":
            if (
                self.values["a11y"].get("reduced_motion", "yes").lower() == "yes"
                and low == "expressive"
            ):
                return (
                    None  # expressive is fine: reduced-motion still honored in tokens
                )
            if low == "always animate everything, ignore prefers-reduced-motion":
                return "motion contradicts reduced-motion=yes; repair: expressive motion with a reduced-motion off-ramp."
        if axis == "effects" and slot == "decoration" and low == "yes":
            # validate_effects_form already repairs unrestricted decoration.
            return None
        return None

    # -- token emission ---------------------------------------------------

    def _color_hex(self, word, fallback_word):
        word = _norm(word).lower() or fallback_word
        return PRIMITIVES["color"].get(word, PRIMITIVES["color"][fallback_word])

    def to_tokens(self):
        """Build the primitive -> semantic -> component token tree.

        Every non-primitive ``$value`` is an alias, so a completed loop
        (including all-skip) mints zero one-off tokens. Color pairs are
        contrast-gated: any chosen combination below AA is nudged with the
        ratio-first generator before it becomes a primitive.
        """
        text_level = self.effective("a11y", "text_level").upper()
        large_level = self.effective("a11y", "large_text_level").upper()
        body_target = 7.0 if text_level == "AAA" else _contrast.WCAG_AA_NORMAL
        large_target = 4.5 if large_level == "AA" else _contrast.WCAG_AA_LARGE

        primary = self._color_hex(self.effective("color", "primary"), "ocean")
        neutral = self._color_hex(self.effective("color", "neutral"), "slate")
        accent_word = _norm(self.effective("color", "accent")).lower()
        accent = self._color_hex(accent_word, "teal") if accent_word != "none" else None
        paper, ink = PRIMITIVES["color"]["paper"], PRIMITIVES["color"]["ink"]

        # Ratio-first: nudge the brand color until body text on paper passes.
        primary = _contrast.ensure_ratio(primary, paper, body_target)
        if _contrast.contrast_ratio(neutral, paper) < body_target:
            neutral = _contrast.ensure_ratio(neutral, paper, body_target)

        modes = _norm(self.effective("dark_light", "modes")).lower()
        surface_word = _norm(self.effective("dark_light", "surface")).lower()
        dark_surface = {"true black": "#000000", "lifted gray": "#1f2937"}.get(
            surface_word, "#172554"
        )
        dark_on = "#f8fafc"
        if _contrast.contrast_ratio(primary, dark_surface) < body_target:
            dark_primary = _contrast.ensure_ratio(primary, dark_surface, body_target)
        else:
            dark_primary = primary

        scale = TYPE_SCALES[_norm(self.effective("type", "scale"))]
        base = int(_norm(self.effective("type", "base_size")))
        steps = [round(base * (scale**i), 2) for i in range(6)]
        assert all(b > a for a, b in zip(steps, steps[1:])), "scale monotonicity"

        family_word = _norm(self.effective("type", "family")).lower()
        density_word = _norm(self.effective("layout", "density")).lower()
        radius_pair = RADIUS_SETS[_norm(self.effective("layout", "radius")).lower()]
        motion_word = _norm(self.effective("effects", "motion")).lower()
        reduced = _norm(self.effective("a11y", "reduced_motion")).lower() == "yes"

        color_primitives = {
            "brand-500": {
                "$value": primary,
                "$type": "color",
                "$description": "Primary brand color (contrast-gated).",
            },
            "neutral-500": {
                "$value": neutral,
                "$type": "color",
                "$description": "Neutral text/support color (contrast-gated).",
            },
            "paper": {
                "$value": paper,
                "$type": "color",
                "$description": "Light surface.",
            },
            "ink": {
                "$value": ink,
                "$type": "color",
                "$description": "Light body text.",
            },
            "dark-surface": {
                "$value": dark_surface,
                "$type": "color",
                "$description": "Dark-mode surface.",
            },
            "dark-ink": {
                "$value": dark_on,
                "$type": "color",
                "$description": "Dark-mode body text.",
            },
            "dark-brand-500": {
                "$value": dark_primary,
                "$type": "color",
                "$description": "Dark-mode brand color (contrast-gated).",
            },
        }
        if accent is not None:
            color_primitives["accent-500"] = {
                "$value": accent,
                "$type": "color",
                "$description": "Accent color.",
            }

        semantic_text = (
            "{color.primitive.brand-500}"
            if _contrast.contrast_ratio(primary, paper) >= body_target
            else "{color.primitive.neutral-500}"
        )
        tokens = {
            "color": {
                "primitive": color_primitives,
                "semantic": {
                    "primary": {
                        "$value": "{color.primitive.brand-500}",
                        "$type": "color",
                        "$description": "Brand primary alias.",
                    },
                    "text-body": {
                        "$value": semantic_text,
                        "$type": "color",
                        "$description": "Body text alias (gated).",
                    },
                    "surface": {
                        "$value": "{color.primitive.paper}",
                        "$type": "color",
                        "$description": "Default surface alias.",
                    },
                    "text-body-dark": {
                        "$value": "{color.primitive.dark-ink}",
                        "$type": "color",
                        "$description": "Dark-mode body text alias.",
                    },
                },
                "component": {
                    "$type": "color",
                    "button-background": {"$value": "{color.semantic.primary}"},
                    "button-text": {"$value": "{color.primitive.paper}"},
                    "link-text": {"$value": "{color.semantic.text-body}"},
                },
            },
            "type": {
                "primitive": {
                    "family-base": {
                        "$value": TYPE_STACKS.get(family_word, TYPE_STACKS["system"]),
                        "$type": "fontFamily",
                        "$description": "Base type stack.",
                    },
                    "size-base": {
                        "$value": {"value": base, "unit": "px"},
                        "$type": "dimension",
                        "$description": "Base body size.",
                    },
                    "scale-ratio": {
                        "$value": scale,
                        "$type": "number",
                        "$description": "Modular scale ratio.",
                    },
                    **{
                        f"heading-{i + 1}": {
                            "$value": {"value": s, "unit": "px"},
                            "$type": "dimension",
                            "$description": f"Scale step {i + 1} (primitive).",
                        }
                        for i, s in enumerate(reversed(steps))
                    },
                },
                "semantic": {
                    "body": {
                        "$value": "{type.primitive.family-base}",
                        "$type": "fontFamily",
                    },
                    "body-size": {
                        "$value": "{type.primitive.size-base}",
                        "$type": "dimension",
                    },
                    **{
                        f"heading-{i + 1}": {
                            "$value": "{type.primitive.heading-%d}" % (i + 1),
                            "$type": "dimension",
                        }
                        for i in range(6)
                    },
                },
                "component": {
                    "$type": "dimension",
                    **{
                        f"heading-{i + 1}": {
                            "$value": "{type.semantic.heading-%d}" % (i + 1)
                        }
                        for i in range(6)
                    },
                },
            },
            "space": {
                "primitive": {
                    "base": {
                        "$value": {
                            "value": int(DENSITY_SPACE.get(density_word, "8")),
                            "unit": "px",
                        },
                        "$type": "dimension",
                        "$description": "Density base step.",
                    },
                    "grid-columns": {
                        "$value": int(_norm(self.effective("layout", "grid"))),
                        "$type": "number",
                    },
                },
                "semantic": {
                    "md": {"$value": "{space.primitive.base}", "$type": "dimension"},
                },
            },
            "radius": {
                "primitive": {
                    "sm": {
                        "$value": {"value": int(radius_pair[0]), "unit": "px"},
                        "$type": "dimension",
                    },
                    "lg": {
                        "$value": {"value": int(radius_pair[1]), "unit": "px"},
                        "$type": "dimension",
                    },
                },
                "semantic": {
                    "control": {
                        "$value": "{radius.primitive.sm}",
                        "$type": "dimension",
                    },
                    "card": {"$value": "{radius.primitive.lg}", "$type": "dimension"},
                },
            },
            "motion": {
                "primitive": {
                    "duration-base": {
                        "$value": {
                            "value": int(MOTION_MS.get(motion_word, "150")),
                            "unit": "ms",
                        },
                        "$type": "duration",
                    },
                    "reduced-motion": {
                        "$value": "reduce" if reduced else "no-preference",
                        "$type": "string",
                    },
                },
                "semantic": {
                    "control": {
                        "$value": "{motion.primitive.duration-base}",
                        "$type": "duration",
                    },
                },
            },
            "modes": {
                "$type": "string",
                "primitive": {"supported": {"$value": modes}},
                "semantic": {"current": {"$value": "{modes.primitive.supported}"}},
            },
        }
        return tokens

    def probe_pairs(self):
        """Text color pairs (name, fg, bg, large?) for the contrast gate."""
        tokens = self.to_tokens()
        prim = tokens["color"]["primitive"]
        pairs = [
            (
                "body on paper",
                prim["neutral-500"]["$value"],
                prim["paper"]["$value"],
                False,
            ),
            (
                "brand on paper",
                prim["brand-500"]["$value"],
                prim["paper"]["$value"],
                False,
            ),
            (
                "body on dark",
                prim["dark-ink"]["$value"],
                prim["dark-surface"]["$value"],
                False,
            ),
        ]
        if "accent-500" in prim:
            pairs.append(
                (
                    "accent large on paper",
                    prim["accent-500"]["$value"],
                    prim["paper"]["$value"],
                    True,
                )
            )
        return pairs
