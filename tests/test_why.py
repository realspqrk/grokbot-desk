"""The why line: sentence splitting (German abbreviations, ordinals, dates)
and the banner's fold. Moved with the splitter from the task module."""
import pytest

from core.why import present_why, sentences, split_why


def test_split_why_keeps_three_sentences_and_folds_the_rest():
    assert split_why("One. Two? Three! Four. Five.") == ("One. Two? Three!", "Four. Five.")
    assert split_why("Short one.") == ("Short one.", "")
    assert split_why("") == ("", "")


@pytest.mark.parametrize(
    "text",
    [
        "Wir buchen z. B. den Saal am Fluss.",
        "Das kostet ca. 5 Minuten.",
        "Siehe Nr. 3 der Liste.",
        "Dr. Müller hat zugestimmt.",
        "Das heißt d. h. weniger Aufwand.",
        "Es geht u. a. um die Preise.",
        "Morgen bzw. übermorgen passt.",
        "Der 1. Schritt ist erledigt.",
        "Version 2.5 ist live.",
        "Wir nehmen z.B. den zweiten Raum.",
        "We pick e.g. the second room.",
        "Signed by Mr. Smith today.",
        "Zum 100. Geburtstag laden wir ein.",
        "Am 31.12. bleibt der Laden geschlossen.",
        "Wir liefern Version 2.4. Danach prüfen wir.",
        # accepted: a count before a full stop reads like an ordinal
        "Es sind 12. Nicht deployen.",
    ],
)
def test_a_german_abbreviation_or_ordinal_never_ends_a_sentence(text):
    assert sentences(text) == [text]


def test_sentences_still_split_after_a_real_end_and_keep_closing_quotes():
    assert sentences("Er sagte „ja.“ Dann ging er.") == ["Er sagte „ja.“", "Dann ging er."]
    assert sentences("Äpfel, Birnen usw. Danach kam der Rest.") == ["Äpfel, Birnen usw.", "Danach kam der Rest."]
    assert sentences("Eins. Zwei! Drei?") == ["Eins.", "Zwei!", "Drei?"]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Fertig... Nicht deployen. Erst pruefen. Sonst stoppen.",
         ["Fertig...", "Nicht deployen.", "Erst pruefen.", "Sonst stoppen."]),
        ("Fertig… Nicht deployen.", ["Fertig…", "Nicht deployen."]),
        ("Das war 2026. Jetzt kommt 2027.", ["Das war 2026.", "Jetzt kommt 2027."]),
        ("Das war im Jahr 2026. Danach kam mehr.", ["Das war im Jahr 2026.", "Danach kam mehr."]),
        ("Siehe example.com. Dort steht mehr.", ["Siehe example.com.", "Dort steht mehr."]),
        ("Der 1. Schritt ist erledigt. Am 15. Mai folgt der Rest.",
         ["Der 1. Schritt ist erledigt.", "Am 15. Mai folgt der Rest."]),
    ],
)
def test_ellipses_numbers_and_dotted_words_end_a_sentence(text, expected):
    assert sentences(text) == expected


def test_a_four_sentence_why_after_an_ellipsis_still_folds():
    shown, more = present_why("Fertig... Nicht deployen. Erst pruefen. Sonst stoppen.")
    assert shown == "Fertig... Nicht deployen. Erst pruefen."
    assert more == "Sonst stoppen."


def test_a_why_keeps_its_line_breaks():
    shown, more = split_why("Erste Zeile.\nZweite Zeile.\n\nDritte Zeile.\nVierte Zeile.")
    assert shown == "Erste Zeile.\nZweite Zeile.\n\nDritte Zeile."
    assert more == "Vierte Zeile."
    assert split_why("Punkt eins\nPunkt zwei") == ("Punkt eins\nPunkt zwei", "")


def test_a_long_run_is_cut_at_a_word_boundary_with_an_ellipsis():
    text = ("Wort" + "x" * 6 + " ") * 40  # one sentence, 440 characters
    shown, more = present_why(text)
    assert len(shown) <= 361
    assert shown.endswith("…")
    head = shown[:-1]
    assert text.startswith(head) and text[len(head)] == " ", "cut between two words"
    assert more and (head + " " + more).split() == text.split()
