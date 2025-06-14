import time


def pretty_print(message = "", delay=None, overwrite=False, end='\n'):
    """
    Pretty print for chatbot messages.
    """
    text = ""
    if overwrite:
        text += "\033[F\033[K"

    text += f"{message}"
    
    if delay is not None:
        slow_print(text, delay, end=end)
    else:
        print(text, end=end)

def slow_print(text, delay=0.05, end='\n'):
    for char in text:
        print(char, end='', flush=True)
        time.sleep(delay)
    print(end, end='')
    
    
    