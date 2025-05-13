import time


def pretty_print(role, message, delay=None, overwrite=False):
    """
    Pretty print for chatbot messages.
    """
    lower_role = role.lower()
    text = ""
    if overwrite:
        text += "\033[F\033[K"

    if lower_role == "system":
        text += f"\033[34m{role}: \033[0m{message}"
    elif lower_role == "user":
        text += f"\033[32m{role}: \033[0m{message}"
    elif lower_role == "kurisu":
        text += f"\033[31m{role}: \033[0m{message}"
    else:
        text += f"{role}: {message}"
    if delay is not None:
        slow_print(text, delay)
    else:
        print(text)

def slow_print(text, delay=0.05):
    for char in text:
        print(char, end='', flush=True)
        time.sleep(delay)
    print()
    
    
    