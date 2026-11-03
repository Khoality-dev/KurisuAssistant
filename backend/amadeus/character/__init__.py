"""The character store: where a persona's animation assets live and what may delete them.

``routers/character.py`` serves and accepts the files; this package owns the
things that must not be decided route by route — where the files are
(``paths``), what a ``character_config`` looks like (``schema``: a required
``kind`` and the two systems' members), and which files a saved one still needs
(``references``, ``config_write``). Every writer of ``character_config`` goes
through ``config_write.plan_character_config`` so that the persona route and
the character-config route cannot disagree about what a save means or what it
may delete.
"""
