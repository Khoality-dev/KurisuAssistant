"""The character store: where a persona's animation assets live and what may delete them.

``routers/character.py`` serves and accepts the files; this package owns the two
things that must not be decided route by route — where the files are
(``paths``) and which of them a saved ``character_config`` still needs
(``references``, ``config_write``). Every writer of ``character_config`` goes
through ``config_write.apply_character_config`` so that the persona route and
the character-config route cannot disagree about what a save may delete.
"""
